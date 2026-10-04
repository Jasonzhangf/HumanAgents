import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonlOrganJournal } from '../../../packages/adapters/jsonl/src/index.js';
import {
  executionPolicyHash,
  SubscriptionControlError,
  SubscriptionControlPort,
  SubscriptionSchedulerError,
} from '../../../packages/runtime/src/index.js';
import type {
  ExecutionPolicyBase,
  ExecutionPolicyDefinition,
  Occurrence,
  ServeTaskTerminalReceipt,
  SubscriptionControlRequest,
  TaskId,
} from '../../../packages/contracts/src/index.js';
import { id, type EvidenceRef } from '../../../packages/contracts/src/index.js';

const scope = { organId: id('organ', 'organ-a'), taskId: id('task', 'task-a') };

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: label,
    scope,
  };
}

function basePolicy(overrides: Partial<ExecutionPolicyBase> = {}): ExecutionPolicyBase {
  return {
    policyId: 'policy-a',
    policyRevision: 1,
    timezone: 'America/Los_Angeles',
    canonicalInstant: '2026-10-03T00:00:00.000Z',
    dstMode: 'wall',
    dstMissedPolicy: 'shift-forward',
    dstAmbiguousPolicy: 'earlier-offset',
    latePolicy: 'run-once',
    busyPolicy: 'skip',
    ...overrides,
  };
}

function policy(overrides: Partial<ExecutionPolicyDefinition> = {}): ExecutionPolicyDefinition {
  return { ...basePolicy(), ...overrides } as ExecutionPolicyDefinition;
}

function control(overrides: Partial<SubscriptionControlRequest> = {}): SubscriptionControlRequest {
  return {
    subscriptionId: 'subscription-a',
    expectedPolicyRevision: 1,
    expectedScheduleRevision: 1,
    idempotencyKey: 'control-1',
    requestedAt: '2026-10-03T00:00:00.000Z',
    action: 'pause',
    ...overrides,
  } as SubscriptionControlRequest;
}

function claim(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionId: 'subscription-a',
    scheduleRevision: 1,
    occurrenceOrdinal: 1,
    dueAt: '2026-10-03T00:00:00.000Z',
    taskId: id('task', 'task-a'),
    operationId: id('operation', 'operation-a'),
    inputArtifactDigest: 'sha256:input',
    schedulerInstanceId: 'scheduler-a',
    leaseId: 'lease-1',
    generation: 1,
    executionEpoch: 1,
    nowAt: '2026-10-03T00:00:00.000Z',
    leaseUntil: '2026-10-03T00:05:00.000Z',
    ...overrides,
  };
}

function idempotencySlotClaim(overrides: Record<string, unknown> = {}) {
  return claim({
    subscriptionId: 'subscription-b',
    scheduleRevision: 1,
    occurrenceOrdinal: 1,
    dueAt: '2026-10-03T00:00:00.000Z',
    taskId: id('task', 'task-b'),
    operationId: id('operation', 'operation-b'),
    ...overrides,
  });
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionId: 'subscription-a',
    goalId: 'goal-a',
    scheduleRevision: 1,
    state: 'active' as const,
    busyPolicy: 'skip' as const,
    currentOccurrenceOrdinal: 0,
    ...overrides,
  };
}

function terminal(taskId: TaskId = id('task', 'task-a'), overrides: Partial<ServeTaskTerminalReceipt> = {}): ServeTaskTerminalReceipt {
  const verification = {
    taskId,
    operationId: id('operation', 'operation-a'),
    executionEpoch: 1,
    inputArtifactDigest: 'sha256:input',
    status: 'success' as const,
    checkerStdout: 'ok',
    checkerExitCode: 0,
    evidenceRefs: [evidence('terminal')],
  };
  return {
    taskId,
    operationId: verification.operationId,
    executionEpoch: verification.executionEpoch,
    inputArtifactDigest: verification.inputArtifactDigest,
    verification,
    terminalCheckpointRef: 'checkpoint:terminal',
    settlementReceiptRef: 'receipt:settled',
    ...overrides,
  };
}

async function withStore<T>(work: (port: SubscriptionControlPort, file: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-subscriptions-'));
  const file = join(root, 'subscriptions.jsonl');
  try {
    return await work(new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file), file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('duplicate claim is idempotent per generation and lease', async () => {
  await withStore(async (port) => {
    await port.create(subscription(), policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const first = await port.claim(claim());
    const duplicate = await port.claim(claim({ leaseUntil: '2026-10-03T00:05:00.000Z' }));
    assert.deepEqual(duplicate, first);
    await assert.rejects(
      () => port.claim(claim({ generation: 2, leaseId: 'lease-2' })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'lease-generation',
    );
    await assert.rejects(
      () => port.claim(claim({ leaseUntil: '2026-10-03T00:01:00.000Z', nowAt: '2026-10-03T00:06:00.000Z' })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'lease-expired',
    );
    await assert.rejects(
      () => port.claim(claim({ taskId: id('task', 'other-task') })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'invalid-occurrence',
    );
    await assert.rejects(
      () => port.claim(claim({ dueAt: '2026-10-03T00:01:00.000Z' })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'invalid-occurrence',
    );
  });
});

test('claim fence rejects superseded schedule revisions after control', async () => {
  await withStore(async (port) => {
    await port.create(subscription(), policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const claimed = await port.claim(claim());
    await port.control(control({
      action: 'cancel-future',
      idempotencyKey: 'cancel-claimed',
      requestedAt: '2026-10-03T00:01:00.000Z',
    }));
    assert.equal((await port.claimRecord(claimed.occurrenceId)).expiresAt, claimed.expiresAt);
    await assert.rejects(
      () => port.claim(claim()),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'superseded',
    );
  });
});

test('control before claim supersedes unclaimed occurrence and blocks claim', async () => {
  await withStore(async (port) => {
    await port.create(subscription(), policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const result = await port.control(control({
      action: 'pause',
      idempotencyKey: 'pause-before-claim',
    }));
    assert.equal(result.status, 'applied');
    assert.equal((await port.snapshot('subscription-a')).subscription.state, 'suspended');
    await assert.rejects(
      () => port.claim(claim()),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'invalid-occurrence',
    );
  });
});

test('claim before control keeps immutable in-flight policy and future cancel', async () => {
  await withStore(async (port) => {
    await port.create(subscription(), policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const claimed = await port.claim(claim());
    const canceled = await port.control(control({
      action: 'cancel-future',
      idempotencyKey: 'cancel-after-claim',
      requestedAt: '2026-10-03T00:01:00.000Z',
    }));
    assert.equal(canceled.status, 'applied');
    assert.equal((await port.claimRecord(claimed.occurrenceId)).policy.policyRevision, 1);
    assert.equal((await port.snapshot('subscription-a')).subscription.state, 'cancelled');
  });
});

test('same-base modify produces one applied receipt and one stale receipt', async () => {
  await withStore(async (port) => {
    await port.create(subscription(), policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const firstPolicy = policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z', policyId: 'policy-b', policyRevision: 2 });
    const secondPolicy = policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z', policyId: 'policy-c', policyRevision: 3 });
    const first = control({
      action: 'modify',
      idempotencyKey: 'modify-b',
      newPolicy: firstPolicy,
      newPolicyHash: executionPolicyHash(firstPolicy),
      confirmationRef: 'confirm:b',
    });
    const second = control({
      action: 'modify',
      idempotencyKey: 'modify-c',
      newPolicy: secondPolicy,
      newPolicyHash: executionPolicyHash(secondPolicy),
      confirmationRef: 'confirm:c',
      requestedAt: '2026-10-03T00:00:01.000Z',
    });
    const [left, right] = await Promise.all([port.control(first), port.control(second)]);
    assert.deepEqual([left.status, right.status].sort(), ['applied', 'stale']);
    const third = await port.control(control({
      action: 'modify',
      idempotencyKey: 'modify-d',
      newPolicy: firstPolicy,
      newPolicyHash: executionPolicyHash(firstPolicy),
      confirmationRef: 'confirm:d',
      requestedAt: '2026-10-03T00:00:02.000Z',
    }));
    assert.equal(third.status, 'stale');
  });
});

test('control idempotency distinguishes replay from conflicting content', async () => {
  await withStore(async (port) => {
    await port.create(subscription(), policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const applied = await port.control(control());
    const replay = await port.control(control());
    assert.equal(applied.status, 'applied');
    assert.equal(replay.status, 'duplicate');
    const conflict = await port.control(control({ requestedAt: '2026-10-03T00:01:00.000Z' }));
    assert.equal(conflict.status, 'conflict');
  });
});

test('journal restart replay restores control receipts and claimed policy', async () => {
  await withStore(async (port, file) => {
    await port.create(subscription(), policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const applied = await port.control(control({ action: 'pause', idempotencyKey: 'pause-restart' }));
    const replayed = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    assert.deepEqual(await replayed.receipt('pause-restart'), applied);
    assert.equal((await replayed.snapshot('subscription-a')).subscription.state, 'suspended');
  });
});

test('dueTimes computes once, scheduled, interval, daily and weekly rules and end bounds', async () => {
  await withStore(async (port) => {
    assert.deepEqual(
      await port.dueTimes({ policy: policy({ executionMode: 'once', dueAt: '2026-10-03T00:00:00.000Z' }), nowAt: '2026-10-03T00:00:00.000Z', count: 3 }),
      ['2026-10-03T00:00:00.000Z'],
    );
    assert.deepEqual(
      await port.dueTimes({ policy: policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z', endAt: '2026-10-04T00:00:00.000Z' }), nowAt: '2026-10-03T00:00:00.000Z', count: 3 }),
      ['2026-10-03T00:00:00.000Z'],
    );
    assert.deepEqual(
      await port.dueTimes({
        policy: policy({ executionMode: 'recurring', frequency: 'interval', startAt: '2026-10-03T00:00:00.000Z', intervalMinutes: 60, maxOccurrences: 3 }),
        nowAt: '2026-10-03T02:00:00.000Z',
        count: 3,
      }),
      ['2026-10-03T00:00:00.000Z', '2026-10-03T01:00:00.000Z', '2026-10-03T02:00:00.000Z'],
    );
    assert.deepEqual(
      await port.dueTimes({
        policy: policy({ executionMode: 'recurring', frequency: 'daily', startAt: '2026-10-03T00:00:00.000Z', timeOfDay: '09:00', endAt: '2026-10-05T00:00:00.000Z' }),
        nowAt: '2026-10-04T20:00:00.000Z',
        count: 3,
      }),
      ['2026-10-03T16:00:00.000Z', '2026-10-04T16:00:00.000Z'],
    );
    assert.deepEqual(
      await port.dueTimes({
        policy: policy({ executionMode: 'recurring', frequency: 'weekly', startAt: '2026-10-03T00:00:00.000Z', timeOfDay: '09:00', weekDays: [1, 3] }),
        nowAt: '2026-10-20T20:00:00.000Z',
        count: 4,
      }),
      ['2026-10-07T16:00:00.000Z', '2026-10-12T16:00:00.000Z', '2026-10-14T16:00:00.000Z', '2026-10-19T16:00:00.000Z'],
    );
  });
});

test('dueTimes rejects invalid timezone, policy boundaries and count', async () => {
  await withStore(async (port) => {
    await assert.rejects(
      () => port.dueTimes({ policy: policy({ timezone: 'Invalid/Zone', executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }), nowAt: '2026-10-03T00:00:00.000Z', count: 1 }),
      Error,
    );
    await assert.rejects(
      () => port.dueTimes({ policy: policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z', maxOccurrences: 0 }), nowAt: '2026-10-03T00:00:00.000Z', count: 1 }),
      Error,
    );
    await assert.rejects(
      () => port.dueTimes({ policy: policy({ executionMode: 'once', dueAt: '2026-10-03T00:00:00.000Z' }), nowAt: '2026-10-03T00:00:00.000Z', count: 0 }),
      SubscriptionSchedulerError,
    );
  });
});

test('dueTimes resolves DST gap forward and overlap with earlier offset', async () => {
  await withStore(async (port) => {
    assert.deepEqual(
      await port.dueTimes({
        policy: policy({ executionMode: 'recurring', frequency: 'daily', startAt: '2026-03-08T00:00:00.000Z', timeOfDay: '02:00' }),
        nowAt: '2026-03-09T00:00:00.000Z',
        count: 1,
      }),
      ['2026-03-08T10:00:00.000Z'],
    );
    assert.deepEqual(
      await port.dueTimes({
        policy: policy({ executionMode: 'recurring', frequency: 'daily', startAt: '2026-11-01T00:00:00.000Z', timeOfDay: '01:30' }),
        nowAt: '2026-11-02T00:00:00.000Z',
        count: 1,
      }),
      ['2026-11-01T08:30:00.000Z'],
    );
  });
});

test('late, busy and maxOccurrences consume ordinals and stop at exhaustion', async () => {
  await withStore(async (port) => {
    await port.create(subscription(), policy({
      executionMode: 'recurring',
      frequency: 'interval',
      startAt: '2026-10-03T00:00:00.000Z',
      intervalMinutes: 60,
      maxOccurrences: 2,
      latePolicy: 'skip',
    }));
    const late = await port.schedule({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 1, state: 'due', dueAt: '2026-10-03T00:00:00.000Z' },
      nowAt: '2026-10-03T01:00:00.000Z',
      busy: false,
    });
    assert.equal(late.state, 'skipped-busy');
    const busy = await port.schedule({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 2, state: 'due', dueAt: '2026-10-03T01:00:00.000Z' },
      nowAt: '2026-10-03T01:00:00.000Z',
      busy: true,
    });
    assert.equal(busy.state, 'skipped-busy');
    assert.equal((await port.snapshot('subscription-a')).subscription.state, 'exhausted');
    await assert.rejects(() => port.claim(claim({
      occurrenceOrdinal: 3,
      nowAt: '2026-10-03T02:00:00.000Z',
      leaseUntil: '2026-10-03T02:05:00.000Z',
    })), SubscriptionSchedulerError);
  });
});

test('schedule is idempotent for the same occurrence and rejects exhaustive later slots', async () => {
  await withStore(async (port) => {
    await port.create(subscription(), policy({
      executionMode: 'recurring',
      frequency: 'interval',
      intervalMinutes: 60,
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 2,
    }));
    const first = await port.schedule({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 1, state: 'due', dueAt: '2026-10-03T00:00:00.000Z' },
      nowAt: '2026-10-03T00:00:00.000Z',
    });
    const duplicate = await port.schedule({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 1, state: 'due', dueAt: '2026-10-03T00:00:00.000Z' },
      nowAt: '2026-10-03T00:00:00.000Z',
    });
    assert.deepEqual(duplicate, first);
    await port.schedule({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 2, state: 'due', dueAt: '2026-10-03T01:00:00.000Z' },
      nowAt: '2026-10-03T01:00:00.000Z',
    });
    await assert.rejects(
      () => port.schedule({
        occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 3, state: 'due', dueAt: '2026-10-03T02:00:00.000Z' },
        nowAt: '2026-10-03T02:00:00.000Z',
      }),
      SubscriptionSchedulerError,
    );
  });
});

test('verified terminal settle rejects identity mismatch and does not consume occurrence', async () => {
  await withStore(async (port) => {
    await port.create(subscription(), policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const claimed = await port.claim(claim());
    const bad = terminal(id('task', 'other-task'));
    await assert.rejects(
      () => port.settleOccurrence({ occurrenceId: claimed.occurrenceId, terminal: bad }),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'verification-rejected',
    );
    assert.equal((await port.snapshot('subscription-a')).occurrences[0]?.state, 'claimed');
    const settled = await port.settleOccurrence({ occurrenceId: claimed.occurrenceId, terminal: terminal() });
    assert.equal(settled.occurrence.state, 'consumed');
  });
});

test('serve-task pending is an explicit typed blocker rather than terminal success', async () => {
  await withStore(async (port) => {
    await port.create(subscription(), policy({ executionMode: 'once', dueAt: '2026-10-03T00:00:00.000Z' }));
    await assert.rejects(
      () => port.consumeExecution('subscription-a::1::1'),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'serve-task-pending',
    );
  });
});

test('same due slot resolves its committed occurrence across replay, restart and concurrency', async () => {
  await withStore(async (port, file) => {
    await port.create(subscription(), policy({
      executionMode: 'recurring',
      frequency: 'interval',
      intervalMinutes: 60,
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 3,
    }));
    const dueAt = '2026-10-03T00:00:00.000Z';
    const skipped = await port.schedule({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 1, state: 'due', dueAt },
      nowAt: '2026-10-03T00:20:00.000Z',
      busy: true,
    });
    assert.equal(skipped.state, 'skipped-busy');
    const replayAfterSkip = await port.schedule({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 2, state: 'due', dueAt },
      nowAt: '2026-10-03T00:21:00.000Z',
      busy: false,
    });
    assert.equal(replayAfterSkip.occurrenceOrdinal, 1);
    assert.equal(replayAfterSkip.state, 'skipped-busy');
    const concurrent = await Promise.all([
      port.schedule({
        occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 2, state: 'due', dueAt },
        nowAt: '2026-10-03T00:22:00.000Z',
        busy: false,
      }),
      port.schedule({
        occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 2, state: 'due', dueAt },
        nowAt: '2026-10-03T00:22:00.000Z',
        busy: false,
      }),
    ]);
    assert.deepEqual(concurrent, [replayAfterSkip, replayAfterSkip]);

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    const afterRestart = await restarted.schedule({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 2, state: 'due', dueAt },
      nowAt: '2026-10-03T00:23:00.000Z',
      busy: false,
    });
    assert.deepEqual(afterRestart, replayAfterSkip);
    assert.equal((await restarted.snapshot('subscription-a')).occurrences.filter((occurrence) => occurrence.dueAt === dueAt).length, 1);
    assert.equal((await restarted.snapshot('subscription-a')).subscription.currentOccurrenceOrdinal, 1);

    const secondDueAt = '2026-10-03T01:00:00.000Z';
    await port.schedule({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 2, state: 'due', dueAt: secondDueAt },
      nowAt: secondDueAt,
    });
    const secondClaim = await port.claim(claim({
      occurrenceOrdinal: 2,
      dueAt: secondDueAt,
      nowAt: secondDueAt,
      leaseUntil: '2026-10-03T01:05:00.000Z',
    }));
    const secondSettlement = await port.settleOccurrence({
      occurrenceId: secondClaim.occurrenceId,
      terminal: terminal(),
    });
    const replayConsumed = await port.schedule({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 3, state: 'due', dueAt: secondDueAt },
      nowAt: '2026-10-03T01:06:00.000Z',
    });
    assert.deepEqual(replayConsumed, secondSettlement.occurrence);
    assert.equal((await port.snapshot('subscription-a')).occurrences.filter((occurrence) => occurrence.dueAt === secondDueAt).length, 1);
  });
});

test('claim authority binds to the committed policy slot and rejects forged slots', async () => {
  await withStore(async (port) => {
    await port.create(subscription({ subscriptionId: 'subscription-b' }), policy({
      executionMode: 'scheduled',
      startAt: '2026-10-04T00:00:00.000Z',
      policyId: 'policy-scheduled',
    }));
    await assert.rejects(
      () => port.claim(idempotencySlotClaim({ dueAt: '2026-10-03T00:00:00.000Z', nowAt: '2026-10-03T00:00:00.000Z' })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'invalid-occurrence',
    );
    await assert.rejects(
      () => port.claim(idempotencySlotClaim({
        occurrenceOrdinal: 2,
        dueAt: '2026-10-04T00:00:00.000Z',
        nowAt: '2026-10-04T00:00:00.000Z',
        leaseUntil: '2026-10-04T00:05:00.000Z',
      })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'invalid-occurrence',
    );
    await port.schedule({
      occurrence: { subscriptionId: 'subscription-b', scheduleRevision: 1, occurrenceOrdinal: 1, state: 'due', dueAt: '2026-10-04T00:00:00.000Z' },
      nowAt: '2026-10-04T00:00:00.000Z',
    });
    await assert.rejects(
      () => port.claim(idempotencySlotClaim({
        dueAt: '2026-10-03T23:59:00.000Z',
        nowAt: '2026-10-04T00:00:00.000Z',
        leaseUntil: '2026-10-04T00:05:00.000Z',
      })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'invalid-occurrence',
    );
  });
});

test('expired stored claim cannot be replayed or recover execution authority', async () => {
  await withStore(async (port) => {
    await port.create(subscription(), policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const first = await port.claim(claim());
    await assert.rejects(
      () => port.claim(claim({
        nowAt: '2026-10-03T00:06:00.000Z',
        leaseUntil: '2026-10-03T00:10:00.000Z',
      })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'lease-expired',
    );
    await assert.rejects(
      () => port.claim(claim({
        nowAt: '2026-10-03T00:06:00.000Z',
        leaseUntil: '2026-10-03T00:10:00.000Z',
      })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'lease-expired',
    );
    assert.equal((await port.snapshot('subscription-a')).claims[0]?.expiresAt, first.expiresAt);
  });
});

test('settlement persists the full terminal receipt atomically and replays unchanged after restart', async () => {
  await withStore(async (port, file) => {
    await port.create(subscription(), policy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const claimed = await port.claim(claim());
    const committedTerminal = terminal();
    const committed = await port.settleOccurrence({ occurrenceId: claimed.occurrenceId, terminal: committedTerminal });
    assert.deepEqual(committed.terminal, committedTerminal);
    assert.equal(committed.occurrence.state, 'consumed');
    assert.equal(committed.occurrence.occurrenceId, claimed.occurrenceId);

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    const replay = await restarted.settleOccurrence({ occurrenceId: claimed.occurrenceId, terminal: committedTerminal });
    assert.deepEqual(replay, committed);
    assert.deepEqual((await restarted.settlements())[0], committed);
    const snapshot = await restarted.snapshot('subscription-a');
    assert.equal(snapshot.subscription.currentOccurrenceOrdinal, 1);
    assert.equal(snapshot.occurrences.filter((occurrence) => occurrence.occurrenceId === claimed.occurrenceId).length, 1);
    assert.equal(snapshot.settlements.length, 1);

    const conflictingTerminal = terminal(undefined, { settlementReceiptRef: 'receipt:other' });
    await assert.rejects(
      () => restarted.settleOccurrence({ occurrenceId: claimed.occurrenceId, terminal: conflictingTerminal }),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'verification-rejected',
    );
    assert.deepEqual((await restarted.snapshot('subscription-a')).settlements, [committed]);
  });
});
