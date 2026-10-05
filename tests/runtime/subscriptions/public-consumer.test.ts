import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonlOrganJournal } from '../../../packages/adapters/jsonl/src/index.js';
import type {
  ExecutionPolicyBase,
  ExecutionPolicyDefinition,
  Occurrence,
  ServeTaskTerminalReceipt,
  SubscriptionControlRequest,
} from '../../../packages/contracts/src/index.js';
import { id, type EvidenceRef } from '../../../packages/contracts/src/index.js';
import {
  executionPolicyHash,
  SubscriptionControlError,
  SubscriptionControlPort,
  SubscriptionSchedulerError,
  type ScheduledOccurrenceClaimInput,
  type ScheduledOccurrenceInput,
  type ServeTaskConsumerPort,
} from '../../../packages/runtime/src/index.js';

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

function executionPolicy(overrides: Partial<ExecutionPolicyDefinition> = {}): ExecutionPolicyDefinition {
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

function claimRequest(overrides: Partial<ScheduledOccurrenceClaimInput> = {}): ScheduledOccurrenceClaimInput {
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

function initialSubscription(overrides: Record<string, unknown> = {}) {
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

function occurrenceInput(overrides: Partial<ScheduledOccurrenceInput> = {}): ScheduledOccurrenceInput {
  return {
    occurrence: {
      subscriptionId: 'subscription-a',
      scheduleRevision: 1,
      occurrenceOrdinal: 1,
      state: 'due',
      dueAt: '2026-10-03T00:00:00.000Z',
    } as Occurrence,
    nowAt: '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

function terminalReceipt(overrides: Partial<ServeTaskTerminalReceipt> = {}): ServeTaskTerminalReceipt {
  const verification = {
    taskId: id('task', 'task-a'),
    operationId: id('operation', 'operation-a'),
    executionEpoch: 1,
    attempt: 1,
    inputArtifactDigest: 'sha256:input',
    policyRef: 'task-verification/v1:policy-a',
    policyDigest: 'sha256:policy-a',
    status: 'success' as const,
    checks: [{
      checkId: 'check-terminal',
      kind: 'native' as const,
      status: 'succeeded' as const,
      decisionRef: 'task-verification/v1:terminal',
      decisionDigest: 'sha256:terminal-check',
      artifactDigests: ['sha256:input'],
      evidenceRefs: [evidence('terminal')],
    }],
    evidenceRefs: [evidence('terminal')],
  };
  return {
    taskId: verification.taskId,
    operationId: verification.operationId,
    executionEpoch: verification.executionEpoch,
    inputArtifactDigest: verification.inputArtifactDigest,
    verification,
    terminalCheckpointRef: 'checkpoint:terminal',
    settlementReceiptRef: 'receipt:settled',
    ...overrides,
  };
}

async function withStore<T>(
  work: (port: SubscriptionControlPort, file: string) => Promise<T>,
  serveTask?: ServeTaskConsumerPort,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-subscriptions-'));
  const file = join(root, 'subscriptions.jsonl');
  try {
    await work(new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file, serveTask), file);
    return undefined as never;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('public subscription port commits durable no-due controls and replays idempotency', async () => {
  await withStore(async (port, file) => {
    await port.create(initialSubscription(), executionPolicy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const paused = await port.control(control());
    assert.equal(paused.status, 'applied');
    assert.equal((await port.snapshot('subscription-a')).subscription.state, 'suspended');
    assert.deepEqual(await port.receipt('control-1'), paused);

    const replay = await port.control(control());
    assert.equal(replay.status, 'duplicate');
    const conflict = await port.control(control({ idempotencyKey: 'control-1', requestedAt: '2026-10-03T00:01:00.000Z' }));
    assert.equal(conflict.status, 'conflict');
    await assert.rejects(() => port.receipt('missing-receipt'), SubscriptionControlError);
  });
});

test('same-key different action is a typed conflict', async () => {
  await withStore(async (port) => {
    await port.create(initialSubscription(), executionPolicy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    await port.control(control());
    const conflict = await port.control(control({
      action: 'resume',
      requestedAt: '2026-10-03T00:03:00.000Z',
    }));
    assert.equal(conflict.status, 'conflict');
  });
});

test('terminal and invalid subscription control states remain typed and non-persistent', async () => {
  await withStore(async (port) => {
    await port.create(initialSubscription({ state: 'cancelled' }), executionPolicy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    await assert.rejects(() => port.control(control({ action: 'pause', idempotencyKey: 'pause-terminal' })), (error: unknown) => error instanceof SubscriptionControlError && error.code === 'invalid-state');
    await assert.rejects(() => port.control(control({ action: 'cancel-future', idempotencyKey: 'cancel-terminal', requestedAt: '2026-10-03T00:01:00.000Z' })), (error: unknown) => error instanceof SubscriptionControlError && error.code === 'invalid-state');
    assert.equal((await port.snapshot('subscription-a')).subscription.state, 'cancelled');
    assert.deepEqual((await port.snapshot('subscription-a')).receipts, []);
  });
});

test('public dueTimes rejects invalid timezone rules and count bounds', async () => {
  await withStore(async (port) => {
    await assert.rejects(() => port.dueTimes({ policy: executionPolicy({ timezone: 'Invalid/Zone', executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }), nowAt: '2026-10-03T00:00:00.000Z', count: 1 }), Error);
    await assert.rejects(() => port.dueTimes({ policy: executionPolicy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z', maxOccurrences: 0 }), nowAt: '2026-10-03T00:00:00.000Z', count: 1 }), Error);
    await assert.rejects(() => port.dueTimes({ policy: executionPolicy({ executionMode: 'once', dueAt: '2026-10-03T00:00:00.000Z' }), nowAt: '2026-10-03T00:00:00.000Z', count: 0 }), SubscriptionSchedulerError);
  });
});

test('public subscription controls restart after resume and receipt replay', async () => {
  await withStore(async (port, file) => {
    await port.create(initialSubscription(), executionPolicy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const paused = await port.control(control());
    assert.equal(paused.status, 'applied');
    const resumed = await port.control(control({
      action: 'resume',
      expectedScheduleRevision: 2,
      idempotencyKey: 'control-2',
      requestedAt: '2026-10-03T00:02:00.000Z',
    }));
    assert.equal(resumed.status, 'applied');

    const replayed = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    const snapshot = await replayed.snapshot('subscription-a');
    assert.equal(snapshot.subscription.state, 'active');
    assert.equal(snapshot.subscription.scheduleRevision, 3);
    assert.deepEqual(await replayed.receipt('control-1'), paused);
    assert.deepEqual(await replayed.receipt('control-2'), resumed);
  });
});

test('same-base concurrent modifications apply exactly once', async () => {
  await withStore(async (port) => {
    await port.create(initialSubscription(), executionPolicy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const firstPolicy = executionPolicy({
      executionMode: 'scheduled',
      startAt: '2026-10-03T00:00:00.000Z',
      policyRevision: 2,
      policyId: 'policy-b',
    });
    const secondPolicy = executionPolicy({
      executionMode: 'scheduled',
      startAt: '2026-10-03T00:00:00.000Z',
      policyRevision: 3,
      policyId: 'policy-c',
    });
    const first = control({
      action: 'modify',
      idempotencyKey: 'modify-1',
      newPolicy: firstPolicy,
      newPolicyHash: executionPolicyHash(firstPolicy),
      confirmationRef: 'confirm:policy-b',
    });
    const second = control({
      action: 'modify',
      idempotencyKey: 'modify-2',
      newPolicy: secondPolicy,
      newPolicyHash: executionPolicyHash(secondPolicy),
      confirmationRef: 'confirm:policy-c',
      requestedAt: '2026-10-03T00:00:01.000Z',
    });
    const [left, right] = await Promise.all([port.control(first), port.control(second)]);
    assert.deepEqual([left.status, right.status].sort(), ['applied', 'stale']);
    const applied = left.status === 'applied' ? left : right;
    assert.equal(applied.status, 'applied');
    assert.equal((await port.snapshot('subscription-a')).policy.policyRevision, applied.policyRevision);
    assert.deepEqual(await port.receipt(applied.idempotencyKey), applied);
  });
});

test('materialized due occurrence remains claimable through public scheduler port', async () => {
  await withStore(async (port) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 3,
      frequency: 'interval',
      intervalMinutes: 60,
    }));
    const scheduled = await port.schedule(occurrenceInput());
    assert.equal(scheduled.state, 'due');
    const claimed = await port.claim(claimRequest());
    assert.equal(claimed.occurrenceOrdinal, 1);
    assert.equal((await port.snapshot('subscription-a')).subscription.state, 'active');
  });
});

test('idle-reminder persists a pending reminder without consuming the occurrence ordinal', async () => {
  await withStore(async (port) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 3,
      frequency: 'interval',
      intervalMinutes: 60,
      busyPolicy: 'idle-reminder',
    }));
    const scheduled = await port.schedule(occurrenceInput({ busy: true }));
    assert.equal(scheduled.state, 'reminder-pending');
    const snapshot = await port.snapshot('subscription-a');
    assert.equal(snapshot.subscription.currentOccurrenceOrdinal, 0);
    assert.deepEqual(snapshot.reminders, [{
      reminderId: 'reminder:subscription-a',
      subscriptionId: 'subscription-a',
      scheduleRevision: 1,
      occurrenceOrdinal: 1,
      state: 'pending',
      dueAt: '2026-10-03T00:00:00.000Z',
    }]);
  });
});

test('control and claim linearization preserves claimed policy snapshot and fences superseded slots', async () => {
  await withStore(async (port) => {
    await port.create(initialSubscription(), executionPolicy({ executionMode: 'scheduled', startAt: '2026-10-03T00:00:00.000Z' }));
    const replacementPolicy = executionPolicy({
      executionMode: 'scheduled',
      startAt: '2026-10-03T00:00:00.000Z',
      policyRevision: 2,
    });
    await port.control(control({
      action: 'modify',
      idempotencyKey: 'modify-before-claim',
      newPolicy: replacementPolicy,
      newPolicyHash: executionPolicyHash(replacementPolicy),
      confirmationRef: 'confirm:p2',
    }));
    await assert.rejects(() => port.claim(claimRequest()), SubscriptionSchedulerError);

    await port.create(initialSubscription({ subscriptionId: 'subscription-b' }), executionPolicy({
      executionMode: 'scheduled',
      startAt: '2026-10-03T00:00:00.000Z',
      policyId: 'policy-b',
      maxOccurrences: 1,
    }), 'subscription-b');
    const claim = await port.claim(claimRequest({ subscriptionId: 'subscription-b', leaseId: 'lease-b' }));
    assert.equal(claim.occurrenceOrdinal, 1);
    const canceled = await port.control(control({
      subscriptionId: 'subscription-b',
      action: 'cancel-future',
      idempotencyKey: 'cancel-b',
      requestedAt: '2026-10-03T00:00:01.000Z',
    }));
    assert.equal(canceled.status, 'applied');
    assert.equal((await port.snapshot('subscription-b')).subscription.state, 'cancelled');
    assert.equal((await port.claimRecord('subscription-b::1::1')).policyRevision, 1);
    const consumed = await port.settleOccurrence({
      occurrenceId: claim.occurrenceId,
      terminal: terminalReceipt(),
    });
    assert.equal(consumed.occurrence.state, 'consumed');
    assert.equal((await port.snapshot('subscription-b')).subscription.state, 'cancelled');
  });
});

test('occurrence scheduler handles busy, late, exhaustion and terminal receipt fences', async () => {
  await withStore(async (port) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 2,
      frequency: 'interval',
      intervalMinutes: 60,
    }));
    const busy = await port.schedule(occurrenceInput({ busy: true }));
    assert.equal(busy.state, 'skipped-busy');
    assert.equal((await port.snapshot('subscription-a')).subscription.currentOccurrenceOrdinal, 1);

    const claim = await port.claim(claimRequest({
      occurrenceOrdinal: 2,
      dueAt: '2026-10-03T01:00:00.000Z',
      nowAt: '2026-10-03T01:00:00.000Z',
      leaseUntil: '2026-10-03T01:05:00.000Z',
    }));
    const terminal = terminalReceipt();
    const consumed = await port.settleOccurrence({ occurrenceId: claim.occurrenceId, terminal });
    assert.equal(consumed.occurrence.state, 'consumed');
    assert.equal((await port.snapshot('subscription-a')).subscription.state, 'exhausted');
    const replayed = await port.schedule(occurrenceInput({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 2, state: 'due', dueAt: '2026-10-03T01:00:00.000Z' },
      nowAt: '2026-10-03T01:00:00.000Z',
    }));
    assert.deepEqual(replayed, consumed.occurrence);
    await assert.rejects(() => port.schedule(occurrenceInput({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 3, state: 'due', dueAt: '2026-10-03T02:00:00.000Z' },
      nowAt: '2026-10-03T02:00:00.000Z',
    })), SubscriptionSchedulerError);

    const bad = terminalReceipt({ verification: { ...terminal.verification, status: 'missing' } });
    await assert.rejects(
      () => port.settleOccurrence({ occurrenceId: claim.occurrenceId, terminal: bad }),
      SubscriptionSchedulerError,
    );
  });
});

test('scheduler deterministic DST shift-forward and earlier-offset wall resolution', async () => {
  await withStore(async (port) => {
    assert.equal(await port.nextDue('America/Los_Angeles', '2026-03-08T02:00', '2026-03-08T00:00:00.000Z'), '2026-03-08T10:00:00.000Z');
    assert.equal(await port.nextDue('America/Los_Angeles', '2026-11-01T01:30', '2026-11-01T00:00:00.000Z'), '2026-11-01T08:30:00.000Z');
  });
});

test('public nextOccurrence uses IANA wall rules and respects maxOccurrences', async () => {
  await withStore(async (port) => {
    const daily = executionPolicy({
      executionMode: 'recurring',
      frequency: 'daily',
      startAt: '2026-03-08T00:00:00.000Z',
      timeOfDay: '02:00',
      maxOccurrences: 2,
    });
    await port.create(initialSubscription(), daily);
    const first = await port.nextOccurrence({
      subscription: initialSubscription(),
      policy: daily,
      nowAt: '2026-03-08T10:00:00.000Z',
    });
    assert.equal(first.dueAt, '2026-03-08T10:00:00.000Z');
    const second = await port.nextOccurrence({
      subscription: initialSubscription({ currentOccurrenceOrdinal: 1 }),
      policy: daily,
      nowAt: '2026-03-09T09:00:00.000Z',
    });
    assert.equal(second.dueAt, '2026-03-09T09:00:00.000Z');
    await assert.rejects(
      () => port.nextOccurrence({
        subscription: initialSubscription({ currentOccurrenceOrdinal: 2 }),
        policy: daily,
        nowAt: '2026-03-10T09:00:00.000Z',
      }),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'exhausted',
    );

    const weekly = executionPolicy({
      executionMode: 'recurring',
      frequency: 'weekly',
      startAt: '2026-10-03T00:00:00.000Z',
      timeOfDay: '09:00',
      weekDays: [1, 3],
    });
    await port.create(initialSubscription({ subscriptionId: 'subscription-b' }), weekly, 'subscription-b');
    const weeklyFirst = await port.nextOccurrence({
      subscription: initialSubscription({ subscriptionId: 'subscription-b' }),
      policy: weekly,
      nowAt: '2026-10-05T16:00:00.000Z',
    });
    assert.equal(weeklyFirst.dueAt, '2026-10-05T16:00:00.000Z');
    const weeklySecond = await port.nextOccurrence({
      subscription: initialSubscription({ subscriptionId: 'subscription-b', currentOccurrenceOrdinal: 1 }),
      policy: weekly,
      nowAt: '2026-10-07T16:00:00.000Z',
    });
    assert.equal(weeklySecond.dueAt, '2026-10-07T16:00:00.000Z');
  });
});

test('W3 task verification bridge is explicitly pending at public scheduler port', async () => {
  await withStore(async (port) => {
    await port.create(initialSubscription(), executionPolicy({ executionMode: 'once', dueAt: '2026-10-03T00:00:00.000Z' }));
    await assert.rejects(
      () => port.consumeExecution('subscription-a::1::1', undefined),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'serve-task-pending',
    );
  });
});

test('public scheduler resolves the committed due slot instead of allocating a second ordinal', async () => {
  await withStore(async (port, file) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 2,
      frequency: 'interval',
      intervalMinutes: 60,
    }));
    const dueAt = '2026-10-03T00:00:00.000Z';
    const skipped = await port.schedule(occurrenceInput({ nowAt: '2026-10-03T00:05:00.000Z', busy: true }));
    assert.equal(skipped.state, 'skipped-busy');
    const replay = await port.schedule(occurrenceInput({
      occurrence: { ...occurrenceInput().occurrence, occurrenceOrdinal: 2, dueAt },
      nowAt: '2026-10-03T00:06:00.000Z',
      busy: false,
    }));
    assert.deepEqual(replay, skipped);
    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    assert.deepEqual(await restarted.schedule(occurrenceInput({
      occurrence: { ...occurrenceInput().occurrence, occurrenceOrdinal: 2, dueAt },
      nowAt: '2026-10-03T00:07:00.000Z',
      busy: false,
    })), skipped);
    assert.equal((await restarted.snapshot('subscription-a')).occurrences.length, 1);
  });
});

test('public claim rejects early and additional scheduled slots without side effects', async () => {
  await withStore(async (port) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'scheduled',
      startAt: '2026-10-04T00:00:00.000Z',
    }));
    await assert.rejects(() => port.claim(claimRequest()), SubscriptionSchedulerError);
    assert.deepEqual((await port.snapshot('subscription-a')).claims, []);
    await port.schedule(occurrenceInput({
      occurrence: { subscriptionId: 'subscription-a', scheduleRevision: 1, occurrenceOrdinal: 1, state: 'due', dueAt: '2026-10-04T00:00:00.000Z' },
      nowAt: '2026-10-04T00:00:00.000Z',
    }));
    await assert.rejects(() => port.claim(claimRequest({
      occurrenceOrdinal: 2,
      dueAt: '2026-10-04T01:00:00.000Z',
      nowAt: '2026-10-04T01:00:00.000Z',
      leaseUntil: '2026-10-04T01:05:00.000Z',
    })), SubscriptionSchedulerError);
    assert.equal((await port.snapshot('subscription-a')).claims.length, 0);
  });
});

test('public expired claim is not returned and execution authority cannot use it', async () => {
  let dispatchCount = 0;
  await withStore(async (port, file) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'scheduled',
      startAt: '2026-10-03T00:00:00.000Z',
    }));
    const claim = await port.claim(claimRequest());
    await assert.rejects(
      () => port.claim(claimRequest({ nowAt: '2026-10-03T00:06:00.000Z', leaseUntil: '2026-10-03T00:10:00.000Z' })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'lease-expired',
    );
    await assert.rejects(
      () => port.consumeExecution(claim.occurrenceId, claim),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'lease-expired',
    );
    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file, {
      executeOccurrence: async () => {
        dispatchCount += 1;
        return terminalReceipt();
      },
    });
    await assert.rejects(
      () => restarted.claim(claimRequest({
        nowAt: '2026-10-03T00:06:00.000Z',
        leaseUntil: '2026-10-03T00:10:00.000Z',
      })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'lease-expired',
    );
    await assert.rejects(
      () => restarted.consumeExecution(claim.occurrenceId, claim),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'lease-expired',
    );
    assert.equal((await restarted.claimRecord(claim.occurrenceId)).expiresAt, claim.expiresAt);
    assert.equal(dispatchCount, 0);
  }, {
    executeOccurrence: async () => {
      dispatchCount += 1;
      return terminalReceipt();
    },
  });
  assert.equal(dispatchCount, 0);
});

test('public unexpired claim retains execution authority across restart', async () => {
  const now = Date.now();
  const acquiredAt = new Date(now - 1_000).toISOString();
  const leaseUntil = new Date(now + 60_000).toISOString();
  let dispatchCount = 0;
  await withStore(async (port, file) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'scheduled',
      startAt: acquiredAt,
    }));
    const claim = await port.claim(claimRequest({ dueAt: acquiredAt, nowAt: acquiredAt, leaseUntil }));
    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file, {
      executeOccurrence: async () => {
        dispatchCount += 1;
        return terminalReceipt();
      },
    });
    const terminal = await restarted.consumeExecution(claim.occurrenceId, claim);
    assert.equal(terminal.verification.status, 'success');
    assert.equal(dispatchCount, 1);
  });
  assert.equal(dispatchCount, 1);
});

test('public late execution receives the committed occurrence due time', async () => {
  let dispatchCount = 0;
  let observedDueAt = '';
  await withStore(async (port, file) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'scheduled',
      startAt: '2026-10-03T03:00:00.000Z',
    }));
    const claim = await port.claim(claimRequest({
      dueAt: '2026-10-03T03:00:00.000Z',
      nowAt: '2026-10-03T03:30:00.000Z',
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    }));
    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file, {
      executeOccurrence: async (input) => {
        dispatchCount += 1;
        observedDueAt = input.occurrence.dueAt;
        return terminalReceipt();
      },
    });
    await restarted.consumeExecution(claim.occurrenceId, claim);
    assert.equal(observedDueAt, '2026-10-03T03:00:00.000Z');
    assert.equal(dispatchCount, 1);
  }, {
    executeOccurrence: async (input) => {
      dispatchCount += 1;
      observedDueAt = input.occurrence.dueAt;
      return terminalReceipt();
    },
  });
  assert.equal(observedDueAt, '2026-10-03T03:00:00.000Z');
  assert.equal(dispatchCount, 1);
});

test('public committed slot replay remains available after exhaustion', async () => {
  await withStore(async (port) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'scheduled',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 1,
    }));
    const dueAt = '2026-10-03T00:00:00.000Z';
    const skipped = await port.schedule(occurrenceInput({ nowAt: dueAt, busy: true }));
    assert.equal(skipped.state, 'skipped-busy');
    assert.equal((await port.snapshot('subscription-a')).subscription.state, 'exhausted');

    const replay = await port.schedule(occurrenceInput({
      nowAt: '2026-10-03T00:01:00.000Z',
      busy: false,
    }));
    assert.deepEqual(replay, skipped);
  });
});

test('public completed claim returns its committed terminal instead of redispatching', async () => {
  const now = Date.now();
  const acquiredAt = new Date(now - 1_000).toISOString();
  const leaseUntil = new Date(now + 60_000).toISOString();
  let dispatchCount = 0;
  await withStore(async (port) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'scheduled',
      startAt: acquiredAt,
    }));
    const claim = await port.claim(claimRequest({ dueAt: acquiredAt, nowAt: acquiredAt, leaseUntil }));
    const committed = await port.settleOccurrence({
      occurrenceId: claim.occurrenceId,
      terminal: terminalReceipt(),
    });
    const replay = await port.consumeExecution(claim.occurrenceId, claim);
    assert.deepEqual(replay, committed.terminal);
    assert.equal(dispatchCount, 0);
  }, {
    executeOccurrence: async () => {
      dispatchCount += 1;
      return terminalReceipt();
    },
  });
  assert.equal(dispatchCount, 0);
});

test('public claimed execution remains valid after future cancel', async () => {
  const now = Date.now();
  const acquiredAt = new Date(now - 1_000).toISOString();
  const leaseUntil = new Date(now + 60_000).toISOString();
  let dispatchCount = 0;
  await withStore(async (port) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'scheduled',
      startAt: acquiredAt,
    }));
    const claim = await port.claim(claimRequest({ dueAt: acquiredAt, nowAt: acquiredAt, leaseUntil }));
    const canceled = await port.control(control({
      action: 'cancel-future',
      idempotencyKey: 'cancel-inflight',
      requestedAt: new Date(now + 1).toISOString(),
    }));
    assert.equal(canceled.status, 'applied');
    const terminal = await port.consumeExecution(claim.occurrenceId, claim);
    assert.equal(terminal.verification.status, 'success');
    assert.equal(dispatchCount, 1);
  }, {
    executeOccurrence: async () => {
      dispatchCount += 1;
      return terminalReceipt();
    },
  });
  assert.equal(dispatchCount, 1);
});

test('public modify resets progress for the replacement policy', async () => {
  await withStore(async (port, file) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 3,
      frequency: 'interval',
      intervalMinutes: 60,
    }));
    await port.schedule(occurrenceInput());
    const claim = await port.claim(claimRequest());
    await port.settleOccurrence({ occurrenceId: claim.occurrenceId, terminal: terminalReceipt() });
    assert.equal((await port.snapshot('subscription-a')).subscription.currentOccurrenceOrdinal, 1);

    const replacementPolicy = executionPolicy({
      policyId: 'policy-b',
      policyRevision: 2,
      executionMode: 'scheduled',
      startAt: '2026-10-04T00:00:00.000Z',
    });
    const modified = await port.control(control({
      action: 'modify',
      idempotencyKey: 'modify-after-progress',
      newPolicy: replacementPolicy,
      newPolicyHash: executionPolicyHash(replacementPolicy),
      confirmationRef: 'confirm:policy-b',
    }));
    assert.equal(modified.status, 'applied');
    assert.equal((await port.snapshot('subscription-a')).subscription.currentOccurrenceOrdinal, 0);

    const replacement = occurrenceInput({
      occurrence: {
        subscriptionId: 'subscription-a',
        scheduleRevision: 2,
        occurrenceOrdinal: 1,
        state: 'due',
        dueAt: '2026-10-04T00:00:00.000Z',
      },
      nowAt: '2026-10-04T00:00:00.000Z',
    });
    const scheduled = await port.schedule(replacement);
    assert.equal(scheduled.occurrenceOrdinal, 1);
    assert.equal(scheduled.dueAt, '2026-10-04T00:00:00.000Z');

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    assert.deepEqual(await restarted.schedule(replacement), scheduled);
    assert.equal((await restarted.snapshot('subscription-a')).subscription.state, 'active');
  });
});

test('public old-policy settlement cannot advance replacement progress', async () => {
  await withStore(async (port, file) => {
    await port.create(initialSubscription(), executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 2,
      frequency: 'interval',
      intervalMinutes: 60,
    }));
    const oldClaim = await port.claim(claimRequest());
    const replacementPolicy = executionPolicy({
      policyId: 'policy-b',
      policyRevision: 2,
      executionMode: 'once',
      dueAt: '2026-10-04T00:00:00.000Z',
    });
    await port.control(control({
      action: 'modify',
      idempotencyKey: 'replace-with-once',
      newPolicy: replacementPolicy,
      newPolicyHash: executionPolicyHash(replacementPolicy),
      confirmationRef: 'confirm:policy-b',
    }));

    const settled = await port.settleOccurrence({ occurrenceId: oldClaim.occurrenceId, terminal: terminalReceipt() });
    assert.equal(settled.occurrence.state, 'consumed');
    const snapshot = await port.snapshot('subscription-a');
    assert.equal(snapshot.subscription.scheduleRevision, 2);
    assert.equal(snapshot.subscription.currentOccurrenceOrdinal, 0);
    assert.equal(snapshot.subscription.state, 'active');

    const replacement = occurrenceInput({
      occurrence: {
        subscriptionId: 'subscription-a',
        scheduleRevision: 2,
        occurrenceOrdinal: 1,
        state: 'due',
        dueAt: '2026-10-04T00:00:00.000Z',
      },
      nowAt: '2026-10-04T00:00:00.000Z',
    });
    assert.equal((await port.schedule(replacement)).occurrenceOrdinal, 1);

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    assert.deepEqual(
      await restarted.settleOccurrence({ occurrenceId: oldClaim.occurrenceId, terminal: terminalReceipt() }),
      settled,
    );
    const restartedSnapshot = await restarted.snapshot('subscription-a');
    assert.equal(restartedSnapshot.subscription.currentOccurrenceOrdinal, 0);
    assert.equal(restartedSnapshot.subscription.state, 'active');
  });
});

test('public old-policy settlement cannot advance replacement progress when policy hash is identical', async () => {
  await withStore(async (port, file) => {
    const originalPolicy = executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 2,
      frequency: 'interval',
      intervalMinutes: 60,
    });
    await port.create(initialSubscription(), originalPolicy);
    const oldClaim = await port.claim(claimRequest());

    const identicalPolicy = executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 2,
      frequency: 'interval',
      intervalMinutes: 60,
    });
    assert.equal(executionPolicyHash(identicalPolicy), executionPolicyHash(originalPolicy));
    const modified = await port.control(control({
      action: 'modify',
      idempotencyKey: 'replace-identical-policy',
      newPolicy: identicalPolicy,
      newPolicyHash: executionPolicyHash(identicalPolicy),
      confirmationRef: 'confirm:identical-policy',
    }));
    assert.equal(modified.status, 'applied');
    assert.equal((await port.snapshot('subscription-a')).subscription.scheduleRevision, 2);

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    const persistedModify = await restarted.receipt('replace-identical-policy');
    assert.equal(persistedModify.action, 'modify');
    assert.equal(persistedModify.status, 'applied');
    assert.equal(persistedModify.scheduleRevision, 2);

    await restarted.settleOccurrence({ occurrenceId: oldClaim.occurrenceId, terminal: terminalReceipt() });
    const afterOldSettlement = await restarted.snapshot('subscription-a');
    assert.equal(afterOldSettlement.subscription.currentOccurrenceOrdinal, 0);
    assert.equal(afterOldSettlement.subscription.state, 'active');

    const replacement = occurrenceInput({
      occurrence: {
        subscriptionId: 'subscription-a',
        scheduleRevision: 2,
        occurrenceOrdinal: 1,
        state: 'due',
        dueAt: '2026-10-03T00:00:00.000Z',
      },
      nowAt: '2026-10-03T00:00:00.000Z',
    });
    await restarted.schedule(replacement);
    const replacementClaim = await restarted.claim(claimRequest({
      scheduleRevision: 2,
      occurrenceOrdinal: 1,
      leaseId: 'lease-replacement',
    }));
    await restarted.settleOccurrence({ occurrenceId: replacementClaim.occurrenceId, terminal: terminalReceipt() });
    assert.equal((await restarted.snapshot('subscription-a')).subscription.currentOccurrenceOrdinal, 1);

    const finalRestart = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    const restartedSnapshot = await finalRestart.snapshot('subscription-a');
    assert.equal(restartedSnapshot.subscription.currentOccurrenceOrdinal, 1);
    assert.equal(restartedSnapshot.subscription.state, 'active');
  });
});

test('public returning to an earlier policy cannot revive an older in-flight claim', async () => {
  await withStore(async (port, file) => {
    const originalPolicy = executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 2,
      frequency: 'interval',
      intervalMinutes: 60,
    });
    await port.create(initialSubscription(), originalPolicy);
    const oldClaim = await port.claim(claimRequest());

    const replacementPolicy = executionPolicy({
      policyId: 'policy-b',
      policyRevision: 2,
      executionMode: 'once',
      dueAt: '2026-10-04T00:00:00.000Z',
    });
    await port.control(control({
      action: 'modify',
      idempotencyKey: 'replace-before-return',
      newPolicy: replacementPolicy,
      newPolicyHash: executionPolicyHash(replacementPolicy),
      confirmationRef: 'confirm:policy-b',
    }));
    const restored = await port.control(control({
      action: 'modify',
      expectedPolicyRevision: 2,
      expectedScheduleRevision: 2,
      idempotencyKey: 'restore-earlier-policy',
      requestedAt: '2026-10-03T00:02:00.000Z',
      newPolicy: originalPolicy,
      newPolicyHash: executionPolicyHash(originalPolicy),
      confirmationRef: 'confirm:policy-a-again',
    }));
    assert.equal(restored.status, 'applied');
    const restoredSnapshot = await port.snapshot('subscription-a');
    assert.equal(restoredSnapshot.subscription.scheduleRevision, 3);
    assert.equal(restoredSnapshot.policyHash, executionPolicyHash(originalPolicy));
    assert.equal(restoredSnapshot.subscription.currentOccurrenceOrdinal, 0);

    await port.settleOccurrence({ occurrenceId: oldClaim.occurrenceId, terminal: terminalReceipt() });
    const afterOldSettlement = await port.snapshot('subscription-a');
    assert.equal(afterOldSettlement.subscription.currentOccurrenceOrdinal, 0);
    assert.equal(afterOldSettlement.subscription.state, 'active');

    const replacement = occurrenceInput({
      occurrence: {
        subscriptionId: 'subscription-a',
        scheduleRevision: 3,
        occurrenceOrdinal: 1,
        state: 'due',
        dueAt: '2026-10-03T00:00:00.000Z',
      },
      nowAt: '2026-10-03T00:00:00.000Z',
    });
    await port.schedule(replacement);
    const replacementClaim = await port.claim(claimRequest({
      scheduleRevision: 3,
      occurrenceOrdinal: 1,
      leaseId: 'lease-restored',
    }));
    await port.settleOccurrence({ occurrenceId: replacementClaim.occurrenceId, terminal: terminalReceipt() });
    assert.equal((await port.snapshot('subscription-a')).subscription.currentOccurrenceOrdinal, 1);

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    const restartedSnapshot = await restarted.snapshot('subscription-a');
    assert.equal(restartedSnapshot.subscription.currentOccurrenceOrdinal, 1);
    assert.equal(restartedSnapshot.subscription.state, 'active');
  });
});

test('public same-policy pause and resume preserve in-flight settlement progress', async () => {
  await withStore(async (port, file) => {
    const finitePolicy = executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 2,
      frequency: 'interval',
      intervalMinutes: 60,
    });
    await port.create(initialSubscription(), finitePolicy);
    const claim = await port.claim(claimRequest());
    await port.control(control({ action: 'pause', idempotencyKey: 'pause-before-settle' }));
    await port.settleOccurrence({ occurrenceId: claim.occurrenceId, terminal: terminalReceipt() });
    await port.control(control({
      action: 'resume',
      idempotencyKey: 'resume-before-settle',
      expectedScheduleRevision: 2,
      requestedAt: '2026-10-03T00:01:00.000Z',
    }));
    const resumed = await port.snapshot('subscription-a');
    assert.equal(resumed.subscription.currentOccurrenceOrdinal, 1);
    const next = await port.nextOccurrence({
      subscription: resumed.subscription,
      policy: resumed.policy,
      nowAt: '2026-10-03T01:00:00.000Z',
    });
    assert.equal(next.occurrenceOrdinal, 2);

    await port.create(initialSubscription({ subscriptionId: 'subscription-b' }), executionPolicy({
      policyId: 'policy-b',
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 1,
      frequency: 'interval',
      intervalMinutes: 60,
    }), 'subscription-b');
    const secondClaim = await port.claim(claimRequest({ subscriptionId: 'subscription-b', leaseId: 'lease-b' }));
    await port.control(control({ subscriptionId: 'subscription-b', action: 'pause', idempotencyKey: 'pause-inflight-b' }));
    await port.control(control({
      subscriptionId: 'subscription-b',
      action: 'resume',
      idempotencyKey: 'resume-inflight-b',
      expectedScheduleRevision: 2,
      requestedAt: '2026-10-03T00:01:00.000Z',
    }));
    await port.settleOccurrence({ occurrenceId: secondClaim.occurrenceId, terminal: terminalReceipt() });
    const settled = await port.snapshot('subscription-b');
    assert.equal(settled.subscription.currentOccurrenceOrdinal, 1);
    assert.equal(settled.subscription.state, 'exhausted');
    await assert.rejects(
      () => port.schedule(occurrenceInput({
        occurrence: {
          subscriptionId: 'subscription-b',
          scheduleRevision: 3,
          occurrenceOrdinal: 1,
          state: 'due',
          dueAt: '2026-10-03T01:00:00.000Z',
        },
        nowAt: '2026-10-03T01:00:00.000Z',
      })),
      SubscriptionSchedulerError,
    );

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    const restartedSnapshot = await restarted.snapshot('subscription-b');
    assert.equal(restartedSnapshot.subscription.currentOccurrenceOrdinal, 1);
    assert.equal(restartedSnapshot.subscription.state, 'exhausted');
  });
});

test('public pause and resume preserve progress for the same policy', async () => {
  await withStore(async (port) => {
    const recurringPolicy = executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 3,
      frequency: 'interval',
      intervalMinutes: 60,
    });
    await port.create(initialSubscription(), recurringPolicy);
    await port.schedule(occurrenceInput());
    const claim = await port.claim(claimRequest());
    await port.settleOccurrence({ occurrenceId: claim.occurrenceId, terminal: terminalReceipt() });

    const paused = await port.control(control({ action: 'pause', idempotencyKey: 'pause-progress' }));
    assert.equal(paused.status, 'applied');
    const resumed = await port.control(control({
      action: 'resume',
      idempotencyKey: 'resume-progress',
      expectedScheduleRevision: 2,
      requestedAt: '2026-10-03T00:01:00.000Z',
    }));
    assert.equal(resumed.status, 'applied');
    const snapshot = await port.snapshot('subscription-a');
    assert.equal(snapshot.subscription.currentOccurrenceOrdinal, 1);
    const next = await port.nextOccurrence({
      subscription: snapshot.subscription,
      policy: snapshot.policy,
      nowAt: '2026-10-03T01:00:00.000Z',
    });
    assert.equal(next.occurrenceOrdinal, 2);
    assert.equal(next.dueAt, '2026-10-03T01:00:00.000Z');
  });
});

test('public pause and resume preserve deterministic progress for superseded slots', async () => {
  await withStore(async (port, file) => {
    const recurringPolicy = executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 3,
      frequency: 'interval',
      intervalMinutes: 60,
      busyPolicy: 'idle-reminder',
    });
    await port.create(initialSubscription({ busyPolicy: 'idle-reminder' }), recurringPolicy);
    const due = await port.schedule(occurrenceInput());
    assert.equal(due.state, 'due');
    const reminder = await port.schedule(occurrenceInput({
      occurrence: {
        subscriptionId: 'subscription-a',
        scheduleRevision: 1,
        occurrenceOrdinal: 2,
        state: 'due',
        dueAt: '2026-10-03T01:00:00.000Z',
      },
      nowAt: '2026-10-03T01:00:00.000Z',
      busy: true,
    }));
    assert.equal(reminder.state, 'reminder-pending');

    await port.control(control({ action: 'pause', idempotencyKey: 'pause-superseded' }));
    await port.control(control({
      action: 'resume',
      idempotencyKey: 'resume-superseded',
      expectedScheduleRevision: 2,
      requestedAt: '2026-10-03T01:01:00.000Z',
    }));
    const snapshot = await port.snapshot('subscription-a');
    assert.equal(snapshot.subscription.scheduleRevision, 3);
    assert.equal(snapshot.subscription.currentOccurrenceOrdinal, 2);

    await assert.rejects(
      () => port.schedule(occurrenceInput({
        occurrence: {
          subscriptionId: 'subscription-a',
          scheduleRevision: 1,
          occurrenceOrdinal: 1,
          state: 'due',
          dueAt: '2026-10-03T00:00:00.000Z',
        },
        nowAt: '2026-10-03T02:00:00.000Z',
        busy: true,
      })),
      SubscriptionSchedulerError,
    );
    const next = await port.nextOccurrence({
      subscription: snapshot.subscription,
      policy: snapshot.policy,
      nowAt: '2026-10-03T02:00:00.000Z',
      busy: true,
    });
    assert.equal(next.occurrenceOrdinal, 3);
    assert.equal(next.dueAt, '2026-10-03T02:00:00.000Z');

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    const restartedSnapshot = await restarted.snapshot('subscription-a');
    assert.equal(restartedSnapshot.subscription.currentOccurrenceOrdinal, 2);
    const restartedNext = await restarted.nextOccurrence({
      subscription: restartedSnapshot.subscription,
      policy: restartedSnapshot.policy,
      nowAt: '2026-10-03T02:00:00.000Z',
      busy: true,
    });
    assert.equal(restartedNext.occurrenceOrdinal, 3);
    assert.equal(restartedNext.dueAt, '2026-10-03T02:00:00.000Z');
  });
});

test('public idle reminders coalesce to one pending reminder per subscription', async () => {
  await withStore(async (port, file) => {
    await port.create(initialSubscription({ busyPolicy: 'idle-reminder' }), executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      maxOccurrences: 3,
      frequency: 'interval',
      intervalMinutes: 60,
      busyPolicy: 'idle-reminder',
    }));
    const first = await port.schedule(occurrenceInput({ busy: true }));
    const second = await port.schedule(occurrenceInput({
      occurrence: {
        subscriptionId: 'subscription-a',
        scheduleRevision: 1,
        occurrenceOrdinal: 2,
        state: 'due',
        dueAt: '2026-10-03T01:00:00.000Z',
      },
      nowAt: '2026-10-03T01:00:00.000Z',
      busy: true,
    }));
    assert.equal(first.state, 'reminder-pending');
    assert.equal(second.state, 'reminder-pending');

    const snapshot = await port.snapshot('subscription-a');
    assert.deepEqual(snapshot.occurrences.map(({ occurrenceOrdinal, state, dueAt }) => ({ occurrenceOrdinal, state, dueAt })), [
      { occurrenceOrdinal: 1, state: 'reminder-pending', dueAt: '2026-10-03T00:00:00.000Z' },
      { occurrenceOrdinal: 2, state: 'reminder-pending', dueAt: '2026-10-03T01:00:00.000Z' },
    ]);
    assert.deepEqual(snapshot.reminders, [{
      reminderId: 'reminder:subscription-a',
      subscriptionId: 'subscription-a',
      scheduleRevision: 1,
      occurrenceOrdinal: 2,
      state: 'pending',
      dueAt: '2026-10-03T01:00:00.000Z',
    }]);

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    assert.deepEqual((await restarted.snapshot('subscription-a')).reminders, snapshot.reminders);
  });
});

test('public run-once recovery catches up only the latest missed slot', async () => {
  await withStore(async (port, file) => {
    const recurringPolicy = executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      frequency: 'interval',
      intervalMinutes: 60,
      latePolicy: 'run-once',
    });
    await port.create(initialSubscription(), recurringPolicy);
    const recovered = await port.nextOccurrence({
      subscription: initialSubscription(),
      policy: recurringPolicy,
      nowAt: '2026-10-03T03:30:00.000Z',
    });
    assert.equal(recovered.occurrenceOrdinal, 4);
    assert.equal(recovered.dueAt, '2026-10-03T03:00:00.000Z');
    assert.equal((await port.snapshot('subscription-a')).subscription.currentOccurrenceOrdinal, 3);

    const claim = await port.claim(claimRequest({
      occurrenceOrdinal: 4,
      dueAt: '2026-10-03T03:00:00.000Z',
      nowAt: '2026-10-03T03:30:00.000Z',
      leaseUntil: '2026-10-03T03:35:00.000Z',
    }));
    await port.settleOccurrence({ occurrenceId: claim.occurrenceId, terminal: terminalReceipt() });

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    await assert.rejects(
      () => restarted.schedule(occurrenceInput({
        occurrence: {
          subscriptionId: 'subscription-a',
          scheduleRevision: 1,
          occurrenceOrdinal: 1,
          state: 'due',
          dueAt: '2026-10-03T00:00:00.000Z',
        },
        nowAt: '2026-10-03T03:31:00.000Z',
      })),
      SubscriptionSchedulerError,
    );
    const future = await restarted.nextOccurrence({
      subscription: (await restarted.snapshot('subscription-a')).subscription,
      policy: recurringPolicy,
      nowAt: '2026-10-03T04:00:00.000Z',
    });
    assert.equal(future.occurrenceOrdinal, 5);
    assert.equal(future.dueAt, '2026-10-03T04:00:00.000Z');
  });
});

test('public claim rejects a slot older than committed recovery progress without side effects', async () => {
  let dispatchCount = 0;
  await withStore(async (port, file) => {
    const recurringPolicy = executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      frequency: 'interval',
      intervalMinutes: 60,
      latePolicy: 'run-once',
    });
    await port.create(initialSubscription(), recurringPolicy);
    await port.nextOccurrence({
      subscription: initialSubscription(),
      policy: recurringPolicy,
      nowAt: '2026-10-03T03:30:00.000Z',
    });
    const before = await port.snapshot('subscription-a');
    assert.equal(before.subscription.currentOccurrenceOrdinal, 3);
    assert.deepEqual(before.claims, []);

    await assert.rejects(
      () => port.claim(claimRequest({
        occurrenceOrdinal: 1,
        dueAt: '2026-10-03T00:00:00.000Z',
        nowAt: '2026-10-03T03:31:00.000Z',
        leaseUntil: '2026-10-03T03:36:00.000Z',
      })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'invalid-occurrence',
    );
    assert.deepEqual((await port.snapshot('subscription-a')).claims, []);
    assert.equal((await port.snapshot('subscription-a')).subscription.currentOccurrenceOrdinal, 3);
    await assert.rejects(
      () => port.consumeExecution('subscription-a::1::1'),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'invalid-occurrence',
    );
    assert.equal(dispatchCount, 0);

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file, {
      executeOccurrence: async () => {
        dispatchCount += 1;
        return terminalReceipt();
      },
    });
    const valid = await restarted.claim(claimRequest({
      occurrenceOrdinal: 4,
      dueAt: '2026-10-03T03:00:00.000Z',
      nowAt: '2026-10-03T03:32:00.000Z',
      leaseUntil: '2026-10-03T03:37:00.000Z',
    }));
    assert.equal(valid.occurrenceOrdinal, 4);
  }, {
    executeOccurrence: async () => {
      dispatchCount += 1;
      return terminalReceipt();
    },
  });
  assert.equal(dispatchCount, 0);
});

test('public same-policy pause and resume rejects superseded claim slots without side effects', async () => {
  let dispatchCount = 0;
  await withStore(async (port, file) => {
    const recurringPolicy = executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      frequency: 'interval',
      intervalMinutes: 60,
      maxOccurrences: 3,
      busyPolicy: 'idle-reminder',
    });
    await port.create(initialSubscription({ busyPolicy: 'idle-reminder' }), recurringPolicy);
    await port.schedule(occurrenceInput({ busy: true }));
    await port.schedule(occurrenceInput({
      occurrence: {
        subscriptionId: 'subscription-a',
        scheduleRevision: 1,
        occurrenceOrdinal: 2,
        state: 'due',
        dueAt: '2026-10-03T01:00:00.000Z',
      },
      nowAt: '2026-10-03T01:00:00.000Z',
      busy: true,
    }));
    await port.control(control({ action: 'pause', idempotencyKey: 'pause-claim-old' }));
    await port.control(control({
      action: 'resume',
      idempotencyKey: 'resume-claim-old',
      expectedScheduleRevision: 2,
      requestedAt: '2026-10-03T01:01:00.000Z',
    }));
    const before = await port.snapshot('subscription-a');
    assert.equal(before.subscription.scheduleRevision, 3);
    assert.equal(before.subscription.currentOccurrenceOrdinal, 2);
    assert.deepEqual(before.claims, []);

    await assert.rejects(
      () => port.claim(claimRequest({
        scheduleRevision: 3,
        occurrenceOrdinal: 1,
        dueAt: '2026-10-03T00:00:00.000Z',
        nowAt: '2026-10-03T01:02:00.000Z',
        leaseUntil: '2026-10-03T01:07:00.000Z',
      })),
      (error: unknown) => error instanceof SubscriptionSchedulerError && error.code === 'invalid-occurrence',
    );
    assert.deepEqual((await port.snapshot('subscription-a')).claims, []);
    assert.equal((await port.snapshot('subscription-a')).subscription.currentOccurrenceOrdinal, 2);

    const valid = await port.claim(claimRequest({
      scheduleRevision: 3,
      occurrenceOrdinal: 3,
      dueAt: '2026-10-03T02:00:00.000Z',
      nowAt: '2026-10-03T02:00:00.000Z',
      leaseUntil: '2026-10-03T02:05:00.000Z',
    }));
    assert.equal(valid.occurrenceOrdinal, 3);
    assert.equal(dispatchCount, 0);
  }, {
    executeOccurrence: async () => {
      dispatchCount += 1;
      return terminalReceipt();
    },
  });
  assert.equal(dispatchCount, 0);
});

test('public daily recurrence continues beyond the former calendar horizon', async () => {
  await withStore(async (port) => {
    const daily = executionPolicy({
      executionMode: 'recurring',
      frequency: 'daily',
      startAt: '2026-10-03T00:00:00.000Z',
      timeOfDay: '00:00',
      maxOccurrences: 4000,
      dstMode: 'absolute',
    });
    const due = await port.dueTimes({ policy: daily, nowAt: '2037-09-15T00:00:00.000Z', count: 4000 });
    assert.equal(due.length, 4000);
    assert.equal(due.at(-1), '2037-09-14T00:00:00.000Z');

    await port.create(initialSubscription({ currentOccurrenceOrdinal: 3659 }), daily);
    const next = await port.nextOccurrence({
      subscription: initialSubscription({ currentOccurrenceOrdinal: 3659 }),
      policy: daily,
      nowAt: '2036-10-09T12:00:00.000Z',
    });
    assert.equal(next.occurrenceOrdinal, 3660);
    assert.equal(next.dueAt, '2036-10-09T00:00:00.000Z');
  });
});

test('public daily run-once recovery commits and replays the next occurrence beyond the former horizon', async () => {
  await withStore(async (port, file) => {
    const daily = executionPolicy({
      executionMode: 'recurring',
      frequency: 'daily',
      startAt: '2026-10-03T00:00:00.000Z',
      timeOfDay: '00:00',
      maxOccurrences: 4000,
      dstMode: 'absolute',
    });
    await port.create(initialSubscription(), daily);
    const recovered = await port.nextOccurrence({
      subscription: initialSubscription(),
      policy: daily,
      nowAt: '2036-10-10T12:00:00.000Z',
    });
    assert.equal(recovered.occurrenceOrdinal, 3661);
    assert.equal(recovered.dueAt, '2036-10-10T00:00:00.000Z');

    const committed = await port.snapshot('subscription-a');
    assert.equal(committed.subscription.currentOccurrenceOrdinal, 3660);
    assert.deepEqual(committed.occurrences, [recovered]);

    const restarted = new SubscriptionControlPort(new JsonlOrganJournal(file), scope, file);
    const replayed = await restarted.nextOccurrence({
      subscription: committed.subscription,
      policy: committed.policy,
      nowAt: '2036-10-10T12:00:00.000Z',
    });
    assert.deepEqual(replayed, recovered);
    const replayedSnapshot = await restarted.snapshot('subscription-a');
    assert.equal(replayedSnapshot.subscription.currentOccurrenceOrdinal, 3660);
    assert.deepEqual(replayedSnapshot.occurrences, [recovered]);
  });
});

test('public weekly recurrence continues beyond the former calendar horizon', async () => {
  await withStore(async (port) => {
    const weekly = executionPolicy({
      executionMode: 'recurring',
      frequency: 'weekly',
      startAt: '2026-10-05T00:00:00.000Z',
      timeOfDay: '00:00',
      weekDays: [1],
      maxOccurrences: 600,
      dstMode: 'absolute',
    });
    const due = await port.dueTimes({ policy: weekly, nowAt: '2038-04-01T00:00:00.000Z', count: 600 });
    assert.equal(due.length, 600);
    assert.equal(due.at(-1), '2038-03-29T00:00:00.000Z');

    await port.create(initialSubscription({ currentOccurrenceOrdinal: 523 }), weekly);
    const next = await port.nextOccurrence({
      subscription: initialSubscription({ currentOccurrenceOrdinal: 523 }),
      policy: weekly,
      nowAt: '2036-10-13T00:00:00.000Z',
    });
    assert.equal(next.occurrenceOrdinal, 524);
    assert.equal(next.dueAt, '2036-10-13T00:00:00.000Z');
  });
});

test('public dueTimes returns the latest eligible slots before applying count', async () => {
  await withStore(async (port) => {
    const recurringPolicy = executionPolicy({
      executionMode: 'recurring',
      startAt: '2026-10-03T00:00:00.000Z',
      frequency: 'interval',
      intervalMinutes: 60,
    });
    assert.deepEqual(await port.dueTimes({ policy: recurringPolicy, nowAt: '2026-10-03T03:30:00.000Z', count: 1 }), [
      '2026-10-03T03:00:00.000Z',
    ]);
    assert.deepEqual(await port.dueTimes({ policy: recurringPolicy, nowAt: '2026-10-03T03:30:00.000Z', count: 4 }), [
      '2026-10-03T00:00:00.000Z',
      '2026-10-03T01:00:00.000Z',
      '2026-10-03T02:00:00.000Z',
      '2026-10-03T03:00:00.000Z',
    ]);
  });
});
