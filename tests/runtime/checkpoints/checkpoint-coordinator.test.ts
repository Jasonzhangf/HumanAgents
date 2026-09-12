import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type Checkpoint,
  type CycleId,
  type EvidenceRef,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  completeCheckpoint,
  recallCheckpoint,
} from '../../../packages/runtime/src/checkpoints/coordinator.js';
import {
  CheckpointCoordinatorError,
  CheckpointCompletionError,
  CheckpointRecallError,
} from '../../../packages/runtime/src/checkpoints/errors.js';
import type {
  CheckpointAppendRequest,
  CheckpointAppendReceipt,
  CheckpointChainVerification,
  CheckpointJournalPort,
  LatestCheckpointRecord,
} from '../../../packages/runtime/src/checkpoints/ports.js';
import { assembleCheckpointWindows } from '../../../packages/runtime/src/checkpoints/windows.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const cycle = id('cycle', 'cycle-a');
const scope: ScopeRef = { organId: organ, taskId: task, cycleId: cycle };

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: `records/${label}`,
    scope,
  };
}

function outOfScope(dimension: 'organ' | 'task' | 'cycle' | 'operation'): ScopeRef {
  switch (dimension) {
    case 'organ':
      return { ...scope, organId: id('organ', 'organ-b') };
    case 'task':
      return { ...scope, taskId: id('task', 'task-b') };
    case 'cycle':
      return { ...scope, cycleId: id('cycle', 'cycle-b') };
    case 'operation':
      return { ...scope, operationId: id('operation', 'operation-b') };
  }
}

function checkpoint(
  seq: number,
  previousCheckpointId: Checkpoint['previousCheckpointId'],
  overrides: Partial<Checkpoint> = {},
): Checkpoint {
  return {
    id: id('checkpoint', `checkpoint-${seq}`),
    scope,
    cycleId: cycle,
    seq,
    previousCheckpointId,
    directiveRevision: 1,
    executionEpoch: 4,
    outcome: 'succeeded',
    summary: `checkpoint ${seq}`,
    recoveryStateRef: evidence(`recovery-${seq}`),
    evidenceRefs: [evidence(`completion-${seq}`)],
    next: { kind: 'continue', ref: 'next-node' },
    ...overrides,
  };
}

class FakeJournal implements CheckpointJournalPort {
  verification: CheckpointChainVerification = { valid: true };
  latest: LatestCheckpointRecord | null = null;
  appended: CheckpointAppendRequest[] = [];
  verifyCalls = 0;
  readCalls = 0;
  appendReceipt: CheckpointAppendReceipt | null = null;

  async verify(): Promise<CheckpointChainVerification> {
    this.verifyCalls += 1;
    return this.verification;
  }

  async readLatest(): Promise<LatestCheckpointRecord | null> {
    this.readCalls += 1;
    return this.latest;
  }

  async append(input: CheckpointAppendRequest): Promise<CheckpointAppendReceipt> {
    this.appended.push(input);
    return this.appendReceipt ?? { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq };
  }
}

test('recall verifies the latest checkpoint, preserves recovery state, and bounds both windows', async () => {
  const journal = new FakeJournal();
  const latest = checkpoint(1, null, {
    evidenceRefs: [evidence('one'), evidence('two'), evidence('three')],
  });
  journal.latest = { checkpoint: latest, previous: null };

  const recalled = await recallCheckpoint(journal, {
    ownerId: 'task-owner',
    scope,
    windowLimits: { workingEntries: 3, reportingEvidenceEntries: 1 },
  });

  assert.equal(journal.verifyCalls, 1);
  assert.equal(journal.readCalls, 1);
  assert.equal(recalled?.checkpoint.id.value, 'checkpoint-1');
  assert.equal(recalled?.windows.working.recoveryStateRef.locator, 'records/recovery-1');
  assert.deepEqual(recalled?.windows.working.evidenceRefs.map((ref) => ref.locator), [
    'records/one',
    'records/two',
  ]);
  assert.equal(recalled?.windows.working.truncated, true);
  assert.deepEqual(recalled?.windows.reporting.evidenceRefs.map((ref) => ref.locator), ['records/one']);
  assert.equal(recalled?.windows.reporting.truncated, true);
  assert.equal(recalled?.windows.reporting.summary, 'checkpoint 1');
});

test('recall rejects evidence and recovery references outside checkpoint scope without returning state', async () => {
  const dimensions = ['organ', 'task', 'cycle', 'operation'] as const;

  for (const dimension of dimensions) {
    const badScope = outOfScope(dimension);

    const evidenceJournal = new FakeJournal();
    evidenceJournal.latest = {
      checkpoint: { ...checkpoint(1, null), evidenceRefs: [{ ...evidence('cross-scope'), scope: badScope }] },
      previous: null,
    };
    await assert.rejects(
      () => recallCheckpoint(evidenceJournal, { ownerId: 'task-owner', scope }),
      CheckpointRecallError,
    );

    const recoveryJournal = new FakeJournal();
    recoveryJournal.latest = {
      checkpoint: { ...checkpoint(1, null), recoveryStateRef: { ...evidence('cross-scope'), scope: badScope } },
      previous: null,
    };
    await assert.rejects(
      () => recallCheckpoint(recoveryJournal, { ownerId: 'task-owner', scope }),
      CheckpointRecallError,
    );
  }
});

test('recall stops on invalid journal verification and rejects broken predecessor links', async () => {
  const invalidJournal = new FakeJournal();
  invalidJournal.verification = { valid: false, reason: 'digest mismatch' };
  await assert.rejects(
    () => recallCheckpoint(invalidJournal, { ownerId: 'task-owner', scope }),
    CheckpointRecallError,
  );
  assert.equal(invalidJournal.readCalls, 0);

  const brokenJournal = new FakeJournal();
  const previous = checkpoint(1, null);
  brokenJournal.latest = {
    checkpoint: checkpoint(2, id('checkpoint', 'different-predecessor')),
    previous,
  };
  await assert.rejects(
    () => recallCheckpoint(brokenJournal, { ownerId: 'task-owner', scope }),
    CheckpointRecallError,
  );
});

test('completion validates and closes every supported terminal outcome', async () => {
  const cases: readonly {
    readonly outcome: Checkpoint['outcome'];
    readonly next: Checkpoint['next'];
  }[] = [
    { outcome: 'succeeded', next: { kind: 'continue', ref: 'next-node' } },
    { outcome: 'waiting', next: { kind: 'wait', ref: 'condition-a' } },
    { outcome: 'blocked', next: { kind: 'recover', ref: 'owner-a' } },
    { outcome: 'failed', next: { kind: 'recover', ref: 'remediation-a' } },
    { outcome: 'cancelled', next: { kind: 'stop', ref: 'cancelled-by-user' } },
    { outcome: 'stopped', next: { kind: 'stop', ref: 'settled' } },
    { outcome: 'unknown', next: { kind: 'recover', ref: 'reconcile-a' } },
  ];

  for (const outcome of cases) {
    const journal = new FakeJournal();
    const candidate = checkpoint(1, null, outcome);
    const completed = await completeCheckpoint(journal, {
      ownerId: 'task-owner',
      context: { scope, cycleId: cycle, executionEpoch: 4, directiveRevision: 1 },
      previous: null,
      checkpoint: candidate,
    });
    assert.equal(completed.receipt.seq, 1);
    assert.equal(journal.appended.length, 1);
    assert.equal(journal.appended[0].checkpoint.outcome, outcome.outcome);
  }
});

test('completion rejects scope, cycle, epoch, predecessor, recovery state, evidence, and next-action violations', async () => {
  const base = checkpoint(1, null);
  const invalidContexts = [
    {
      label: 'scope',
      input: {
        ownerId: 'task-owner',
        context: { scope: { ...scope, taskId: id('task', 'task-b') }, cycleId: cycle, executionEpoch: 4 },
        previous: null,
        checkpoint: base,
      },
    },
    {
      label: 'cycle',
      input: {
        ownerId: 'task-owner',
        context: { scope, cycleId: id('cycle', 'cycle-b') as CycleId, executionEpoch: 4 },
        previous: null,
        checkpoint: base,
      },
    },
    {
      label: 'epoch',
      input: {
        ownerId: 'task-owner',
        context: { scope, cycleId: cycle, executionEpoch: 5 },
        previous: null,
        checkpoint: base,
      },
    },
    {
      label: 'previous',
      input: {
        ownerId: 'task-owner',
        context: { scope, cycleId: cycle, executionEpoch: 4 },
        previous: null,
        checkpoint: checkpoint(2, id('checkpoint', 'checkpoint-1')),
      },
    },
    {
      label: 'recovery',
      input: {
        ownerId: 'task-owner',
        context: { scope, cycleId: cycle, executionEpoch: 4 },
        previous: null,
        checkpoint: { ...base, recoveryStateRef: { ...base.recoveryStateRef, locator: '' } },
      },
    },
    {
      label: 'evidence',
      input: {
        ownerId: 'task-owner',
        context: { scope, cycleId: cycle, executionEpoch: 4 },
        previous: null,
        checkpoint: { ...base, evidenceRefs: [] },
      },
    },
    {
      label: 'next',
      input: {
        ownerId: 'task-owner',
        context: { scope, cycleId: cycle, executionEpoch: 4 },
        previous: null,
        checkpoint: { ...base, outcome: 'waiting' as const, next: { kind: 'continue' as const } },
      },
    },
  ];

  for (const violation of invalidContexts) {
    const journal = new FakeJournal();
    await assert.rejects(
      () => completeCheckpoint(journal, violation.input),
      CheckpointCompletionError,
    );
    assert.equal(journal.appended.length, 0, violation.label);
  }
});

test('completion rejects evidence and recovery references outside checkpoint scope before append', async () => {
  const dimensions = ['organ', 'task', 'cycle', 'operation'] as const;

  for (const dimension of dimensions) {
    const badScope = outOfScope(dimension);

    const evidenceJournal = new FakeJournal();
    await assert.rejects(
      () => completeCheckpoint(evidenceJournal, {
        ownerId: 'task-owner',
        context: { scope, cycleId: cycle, executionEpoch: 4, directiveRevision: 1 },
        previous: null,
        checkpoint: { ...checkpoint(1, null), evidenceRefs: [{ ...evidence('cross-scope'), scope: badScope }] },
      }),
      CheckpointCompletionError,
    );
    assert.equal(evidenceJournal.appended.length, 0, `${dimension} evidence must not append`);

    const recoveryJournal = new FakeJournal();
    await assert.rejects(
      () => completeCheckpoint(recoveryJournal, {
        ownerId: 'task-owner',
        context: { scope, cycleId: cycle, executionEpoch: 4, directiveRevision: 1 },
        previous: null,
        checkpoint: { ...checkpoint(1, null), recoveryStateRef: { ...evidence('cross-scope'), scope: badScope } },
      }),
      CheckpointCompletionError,
    );
    assert.equal(recoveryJournal.appended.length, 0, `${dimension} recovery must not append`);
  }
});

test('window assembly never replaces recovery state with a summary and rejects unbounded limits', () => {
  const candidate = checkpoint(1, null);
  const windows = assembleCheckpointWindows(candidate, { workingEntries: 1, reportingEvidenceEntries: 8 });

  assert.equal(windows.working.recoveryStateRef.locator, 'records/recovery-1');
  assert.deepEqual(windows.working.evidenceRefs, []);
  assert.equal(windows.working.truncated, true);
  assert.throws(
    () => assembleCheckpointWindows(candidate, { workingEntries: 0 }),
    CheckpointCoordinatorError,
  );
});
