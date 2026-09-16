import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type Checkpoint,
  type EvidenceRef,
  type OperationId,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import type {
  CheckpointAppendRequest,
  CheckpointAppendReceipt,
  CheckpointChainVerification,
  CheckpointClosurePort,
  CheckpointJournalPort,
  CheckpointReentryAdmissionDecision,
  CheckpointReentryAdmissionPort,
  LatestCheckpointRecord,
} from '../../../packages/runtime/src/checkpoints/ports.js';
import type {
  CheckpointClosureRecord,
  ClosureRecord,
  DeadEndRecord,
  OperationReconcilePort,
} from '../../../packages/runtime/src/checkpoints/closure.js';
import {
  commitDeadEnd,
  commitReentry,
  submitCheckpoint,
  submitInteractionClosure,
  type SubmitCheckpointInput,
} from '../../../packages/runtime/src/checkpoints/submission.js';
import { checkpointCommitId } from '../../../packages/runtime/src/checkpoints/coordinator.js';
import { reconcileUnknownOperations } from '../../../packages/runtime/src/checkpoints/closure.js';
import {
  CheckpointSubmissionError,
} from '../../../packages/runtime/src/checkpoints/errors.js';
import {
  recordDeadEndTool,
  reenterCheckpointTool,
  saveCheckpointTool,
} from '../../../packages/runtime/src/checkpoint-tools/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const cycle = id('cycle', 'cycle-a');
const operation = id('operation', 'operation-a');
const scope: ScopeRef = { organId: organ, taskId: task, cycleId: cycle, operationId: operation };
const interactionScope: ScopeRef = { organId: organ };

function evidence(label: string, evidenceScope: ScopeRef = scope): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: `records/${label}`,
    scope: evidenceScope,
  };
}

function operationEvidence(label: string, operationId: OperationId): EvidenceRef {
  return {
    ...evidence(label, { organId: organ, taskId: task, cycleId: cycle, operationId }),
    kind: 'operation',
  };
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
    directiveRevision: 2,
    executionEpoch: 4,
    outcome: 'waiting',
    summary: `checkpoint ${seq}`,
    recoveryStateRef: evidence(`recovery-${seq}`),
    evidenceRefs: [evidence(`completion-${seq}`)],
    next: { kind: 'wait', ref: 'condition-a' },
    ...overrides,
  };
}

class FakeJournal implements CheckpointJournalPort {
  verification: CheckpointChainVerification = { valid: true };
  readonly latestByScope = new Map<string, LatestCheckpointRecord>();
  appended: CheckpointAppendRequest[] = [];

  private scopeKey(scope: ScopeRef): string {
    return JSON.stringify(scope);
  }

  get latest(): LatestCheckpointRecord | null {
    return [...this.latestByScope.values()].at(-1) ?? null;
  }

  set latest(value: LatestCheckpointRecord | null) {
    this.latestByScope.clear();
    if (value) this.latestByScope.set(this.scopeKey(value.checkpoint.scope), value);
  }

  async verify(): Promise<CheckpointChainVerification> {
    return this.verification;
  }

  async readLatest(scope: ScopeRef): Promise<LatestCheckpointRecord | null> {
    return this.latestByScope.get(this.scopeKey(scope)) ?? null;
  }

  async append(input: CheckpointAppendRequest): Promise<CheckpointAppendReceipt> {
    this.appended.push(input);
    const current = this.latestByScope.get(this.scopeKey(input.checkpoint.scope));
    this.latestByScope.set(this.scopeKey(input.checkpoint.scope), {
      checkpoint: input.checkpoint,
      previous: current?.checkpoint ?? null,
    });
    return { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq };
  }
}

class FakeClosurePort implements CheckpointClosurePort {
  readonly committed: ClosureRecord[] = [];
  readonly records = new Map<string, ClosureRecord>();
  failNextCommit: Error | null = null;

  async commit(input: ClosureRecord): Promise<{ readonly closureId: string; readonly committed: true }> {
    if (this.failNextCommit) {
      const failure = this.failNextCommit;
      this.failNextCommit = null;
      throw failure;
    }
    const closureId = 'closureId' in input
      ? (input as { readonly closureId: string }).closureId
      : (input as DeadEndRecord).deadEndRef;
    this.committed.push(input);
    this.records.set(closureId, input);
    return { closureId, committed: true };
  }

  async read(closureId: string): Promise<ClosureRecord | null> {
    return this.records.get(closureId) ?? null;
  }
}

class FakeAdmissionPort implements CheckpointReentryAdmissionPort {
  decision: CheckpointReentryAdmissionDecision = {
    allowed: true,
    reason: 'permission, resources, and admission are valid',
  };
  readonly calls: Array<Parameters<CheckpointReentryAdmissionPort['admit']>[0]> = [];

  async admit(input: Parameters<CheckpointReentryAdmissionPort['admit']>[0]): Promise<CheckpointReentryAdmissionDecision> {
    this.calls.push(input);
    return this.decision;
  }
}

type SubmissionInput = SubmitCheckpointInput & {
  readonly journal: FakeJournal;
  readonly closurePort: FakeClosurePort;
};

function submissionInput(overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    source: 'agent-tool' as const,
    ownerId: 'task-owner',
    checkpoint: checkpoint(1, null),
    previous: null,
    journal: new FakeJournal(),
    closurePort: new FakeClosurePort(),
    ...overrides,
  };
}

test('unified submission commits agent-tool, harness-control, and recovery closures through one entry', async () => {
  const agentInput = submissionInput();
  const agent = await submitCheckpoint(agentInput);
  assert.equal(agent.state, 'committed');
  assert.equal(agent.closure.source, 'agent-tool');
  assert.equal(agent.reentry.allowed, true);
  assert.equal(agentInput.journal.appended.length, 1);

  const harness = await submitCheckpoint(submissionInput({
    source: 'harness-control',
    checkpoint: checkpoint(1, null, {
      outcome: 'stopped',
      summary: 'model loss after no observable progress',
      evidenceRefs: [evidence('closure'), evidence('settle')],
      next: { kind: 'stop', ref: 'model-loss-no-progress' },
    }),
  }));
  assert.equal(harness.closure.source, 'harness-control');
  assert.equal(harness.reentry.allowed, false);
  assert.equal(harness.reentry.reason.length > 0, true);
  assert.equal(harness.closure.outcome, 'stopped');

  const recovery = await submitCheckpoint(submissionInput({
    source: 'recovery',
    checkpoint: checkpoint(1, null, {
      outcome: 'stopped',
      summary: 'restart recovered stop closure',
      evidenceRefs: [evidence('recovery-stop'), evidence('settle-recovery')],
      next: { kind: 'stop', ref: 'restart-stopped' },
    }),
  }));
  assert.equal(recovery.closure.source, 'recovery');
  assert.equal(recovery.reentry.allowed, false);
  assert.equal(recovery.unresolvedOperations.length, 0);
});

test('unknown operations require reconcile before a stopped closure and force non-reentrant unknown closure', async () => {
  const unknown = operation;
  const unknownOp = submissionInput({
    checkpoint: checkpoint(1, null, {
      outcome: 'stopped',
      evidenceRefs: [evidence('stopped-operation')],
      next: { kind: 'stop', ref: 'stop-with-unknown' },
    }),
    unknownOperations: [unknown],
  });
  await assert.rejects(() => submitCheckpoint(unknownOp), CheckpointSubmissionError);
  assert.equal(unknownOp.journal.appended.length, 0);

  const knownOp = submissionInput({
    checkpoint: checkpoint(1, null, {
      outcome: 'stopped',
      evidenceRefs: [evidence('stopped-resolved')],
      next: { kind: 'stop', ref: 'stop-resolved' },
    }),
    unknownOperations: [unknown],
    reconciledOperations: [{ operationId: unknown, state: 'reconciled', evidenceRef: operationEvidence('reconcile-resolved', unknown) }],
  });
  const resolved = await submitCheckpoint(knownOp);
  assert.equal(resolved.unresolvedOperations.length, 0);
  assert.equal(resolved.closure.evidenceRefs.length, 2);

  const unknownClosure = submissionInput({
    checkpoint: checkpoint(1, null, {
      outcome: 'unknown',
      evidenceRefs: [evidence('unknown-operation')],
      next: { kind: 'recover', ref: 'operation-reconcile' },
    }),
    unknownOperations: [unknown],
  });
  const unknownCommitted = await submitCheckpoint(unknownClosure);
  assert.equal(unknownCommitted.unresolvedOperations.length, 1);
  assert.equal(unknownCommitted.reentry.allowed, false);
  assert.deepEqual(unknownCommitted.reentry.blockedBy, ['unknown-operations']);
});

test('permission revoke commits a blocked non-reentrant closure without inventing admission', async () => {
  const input = submissionInput({
    source: 'harness-control',
    checkpoint: checkpoint(1, null, {
      outcome: 'blocked',
      summary: 'permission revoked while operation was in flight',
      evidenceRefs: [evidence('permission-revoke')],
      next: { kind: 'recover', ref: 're-admission' },
    }),
    permissionRevoked: true,
  });
  const submitted = await submitCheckpoint(input);
  assert.equal(submitted.checkpoint.outcome, 'blocked');
  assert.equal(submitted.reentry.allowed, false);
  assert.equal(submitted.reentry.blockedBy?.includes('permission-revoked'), true);
  assert.equal(input.journal.appended.length, 1);
  assert.equal(input.closurePort.committed.length, 1);
});

test('interaction cancel closes without creating a task checkpoint', async () => {
  const closurePort = new FakeClosurePort();
  const closed = await submitInteractionClosure({
    ownerId: 'interaction-owner',
    closureId: 'interaction-cancel-a',
    scope: interactionScope,
    reason: 'user cancelled interaction',
    evidenceRefs: [evidence('interaction-cancel', interactionScope)],
    closurePort,
    next: { kind: 'recover', ref: 'interaction-reentry' },
  });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closure.closureKind, 'interaction');
  assert.equal(closurePort.committed.length, 1);
});

test('reconcile operation port separates resolved unknowns from unresolved unknowns', async () => {
  const known = operation;
  const otherUnknown = id('operation', 'operation-unknown');
  const otherNotFound = id('operation', 'operation-not-found');
  const port: OperationReconcilePort = {
    async reconcile(input) {
      if (input.operationId.value === known.value) {
        return { operationId: known, state: 'reconciled', evidenceRef: operationEvidence('reconcile-known', known) };
      }
      if (input.operationId.value === otherUnknown.value) {
        return { operationId: otherUnknown, state: 'unknown' };
      }
      return { operationId: otherNotFound, state: 'not-found' };
    },
  };
  const result = await reconcileUnknownOperations(port, [known, otherUnknown, otherNotFound]);
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.unresolved.length, 2);
  assert.deepEqual(result.unresolved.map((operationId) => operationId.value).sort(), [
    otherNotFound.value,
    otherUnknown.value,
  ]);
});

test('dead-end and reentry tools commit separate closure facts before reentry is allowed', async () => {
  const journal = new FakeJournal();
  const closurePort = new FakeClosurePort();
  const admissionPort = new FakeAdmissionPort();
  const context = {
    ownerId: 'task-owner',
    source: 'agent-tool' as const,
    journal,
    closurePort,
    admissionPort,
  };
  const deadEndInput: DeadEndRecord = {
    deadEndRef: 'dead-end-a',
    scope,
    failedPathRefs: ['branch-a'],
    conclusion: 'branch a is a confirmed dead end',
    invalidatedAssumptions: ['layout cache survives full restart'],
    evidenceRefs: [evidence('dead-end')],
    suggestedAlternatives: ['rebuild cache under new epoch'],
  };
  const deadEnd = await recordDeadEndTool(context, { record: deadEndInput });
  assert.equal(deadEnd.state, 'committed');

  const committedCheckpoint = checkpoint(1, null);
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId: context.ownerId,
    checkpoint: committedCheckpoint,
    previous: null,
    journal,
    closurePort,
  });
  const reentry = await reenterCheckpointTool(context, {
    closureId: 'reentry-a',
    checkpoint: committedCheckpoint,
    previousExecutionEpoch: 4,
    newExecutionEpoch: 5,
    deadEndRef: 'dead-end-a',
    nextAction: { kind: 'continue', ref: 'after-dead-end' },
  });
  assert.equal(reentry.state, 'committed');
  assert.equal(reentry.record.reentry.allowed, true);
  assert.equal(admissionPort.calls.length, 1);
  assert.equal(admissionPort.calls[0]?.checkpoint.id.value, committedCheckpoint.id.value);
});

test('reentry retries are idempotent and reject a reused closure id with different content', async () => {
  const journal = new FakeJournal();
  const closurePort = new FakeClosurePort();
  const admissionPort = new FakeAdmissionPort();
  const committedCheckpoint = checkpoint(1, null);
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId: 'task-owner',
    checkpoint: committedCheckpoint,
    previous: null,
    journal,
    closurePort,
  });
  const input = {
    ownerId: 'task-owner',
    closureId: 'reentry-idempotent',
    checkpoint: committedCheckpoint,
    previousExecutionEpoch: 4,
    newExecutionEpoch: 5,
    nextAction: { kind: 'continue' as const, ref: 'after-reentry' },
    journal,
    closurePort,
    admissionPort,
  };

  const first = await commitReentry(input);
  journal.latest = {
    checkpoint: checkpoint(2, committedCheckpoint.id, { id: id('checkpoint', 'checkpoint-later') }),
    previous: committedCheckpoint,
  };
  const retry = await commitReentry(input);
  assert.deepEqual(retry, first);
  assert.equal(admissionPort.calls.length, 1);
  assert.equal(closurePort.committed.length, 2);

  await assert.rejects(
    () => commitReentry({ ...input, newExecutionEpoch: 6 }),
    CheckpointSubmissionError,
  );
  assert.equal(admissionPort.calls.length, 1);
  assert.equal(closurePort.committed.length, 2);
});

test('checkpoint.save tool exposes committed versus blocked outcomes without bypassing unified submission', async () => {
  const context = {
    ownerId: 'task-owner',
    source: 'harness-control' as const,
    journal: new FakeJournal(),
    closurePort: new FakeClosurePort(),
    admissionPort: new FakeAdmissionPort(),
  };
  const saved = await saveCheckpointTool(context, {
    checkpoint: checkpoint(1, null, {
      outcome: 'stopped',
      summary: 'no-progress watchdog stop',
      evidenceRefs: [evidence('watchdog-stop')],
      next: { kind: 'stop', ref: 'no-progress' },
    }),
    previous: null,
  });
  assert.equal(saved.outcome, 'stopped');
  assert.equal(saved.reentry.allowed, false);

  await assert.rejects(
    () => saveCheckpointTool(context, {
      checkpoint: checkpoint(1, null),
      previous: null,
      unknownOperations: [operation],
    }),
    CheckpointSubmissionError,
  );
});

test('checkpoint.save preserves every persisted closure outcome instead of reporting rejected', async () => {
  const cases: readonly {
    readonly outcome: Checkpoint['outcome'];
    readonly next: Checkpoint['next'];
  }[] = [
    { outcome: 'failed', next: { kind: 'recover', ref: 'remediation-a' } },
    { outcome: 'cancelled', next: { kind: 'stop', ref: 'cancelled-by-user' } },
    { outcome: 'stopped', next: { kind: 'stop', ref: 'settled' } },
    { outcome: 'unknown', next: { kind: 'recover', ref: 'reconcile-a' } },
  ];

  for (const item of cases) {
    const context = {
      ownerId: 'task-owner',
      source: 'harness-control' as const,
      journal: new FakeJournal(),
      closurePort: new FakeClosurePort(),
      admissionPort: new FakeAdmissionPort(),
    };
    const saved = await saveCheckpointTool(context, {
      checkpoint: checkpoint(1, null, {
        outcome: item.outcome,
        next: item.next,
        evidenceRefs: [evidence(`outcome-${item.outcome}`)],
      }),
      previous: null,
    });
    assert.equal(saved.outcome, item.outcome);
    assert.equal(context.journal.appended.length, 1);
    assert.equal(context.closurePort.committed.length, 1);
  }
});

test('submission derives reentry from owner facts and ignores no caller-supplied admission', async () => {
  const input = submissionInput({
    checkpoint: checkpoint(1, null, {
      outcome: 'stopped',
      next: { kind: 'stop', ref: 'stopped-by-owner' },
      evidenceRefs: [evidence('owner-stop')],
    }),
  });
  const submitted = await submitCheckpoint(input);
  assert.equal(submitted.reentry.allowed, false);
  assert.deepEqual(submitted.reentry.blockedBy, undefined);
});

test('checkpoint.save cannot commit a model-declared reentry admission', async () => {
  const context = {
    ownerId: 'task-owner',
    source: 'agent-tool' as const,
    journal: new FakeJournal(),
    closurePort: new FakeClosurePort(),
    admissionPort: new FakeAdmissionPort(),
  };
  const saved = await saveCheckpointTool(context, {
    checkpoint: checkpoint(1, null, {
      outcome: 'blocked',
      next: { kind: 'recover', ref: 're-admission' },
      evidenceRefs: [evidence('model-declared-reentry')],
    }),
    previous: null,
  });
  assert.equal(saved.outcome, 'blocked');
  assert.equal(saved.reentry.allowed, false);
  assert.equal(context.closurePort.committed.length, 1);
  assert.equal(context.journal.appended.length, 1);
});

test('checkpoint append retries are idempotent and closure commit failures remain retryable', async () => {
  const journal = new FakeJournal();
  const closurePort = new FakeClosurePort();
  const input = submissionInput({
    journal,
    closurePort,
    checkpoint: checkpoint(1, null),
  });
  closurePort.failNextCommit = new Error('closure store unavailable');

  await assert.rejects(() => submitCheckpoint(input), CheckpointSubmissionError);
  assert.equal(journal.appended.length, 1);
  assert.equal(journal.appended[0]?.commitId, checkpointCommitId(input.checkpoint));
  assert.equal(closurePort.committed.length, 0);

  const retried = await submitCheckpoint(input);
  assert.equal(retried.state, 'committed');
  assert.equal(journal.appended.length, 1);
  assert.equal(closurePort.committed.length, 1);
});

test('checkpoint closure retries require the matching authoritative journal record', async () => {
  const input = submissionInput();
  const first = await submitCheckpoint(input);
  const retry = await submitCheckpoint(input);

  assert.deepEqual(retry, first);
  assert.equal(input.journal.appended.length, 1);
  assert.equal(input.closurePort.committed.length, 1);

  input.journal.latest = null;
  await assert.rejects(() => submitCheckpoint(input), CheckpointSubmissionError);
  assert.equal(input.journal.appended.length, 1);
  assert.equal(input.closurePort.committed.length, 1);
});

test('checkpoint closure retries reject corrupt or mismatched authoritative journal records', async () => {
  const mismatched = submissionInput();
  await submitCheckpoint(mismatched);
  mismatched.journal.latest = {
    checkpoint: checkpoint(1, null, { summary: 'different journal checkpoint' }),
    previous: null,
  };
  await assert.rejects(() => submitCheckpoint(mismatched), CheckpointSubmissionError);
  assert.equal(mismatched.journal.appended.length, 1);
  assert.equal(mismatched.closurePort.committed.length, 1);

  const corrupt = submissionInput();
  await submitCheckpoint(corrupt);
  corrupt.journal.verification = { valid: false, reason: 'digest mismatch' };
  await assert.rejects(() => submitCheckpoint(corrupt), CheckpointSubmissionError);
  assert.equal(corrupt.journal.appended.length, 1);
  assert.equal(corrupt.closurePort.committed.length, 1);
});

test('checkpoint append identity conflicts fail explicitly instead of overwriting history', async () => {
  const journal = new FakeJournal();
  const closurePort = new FakeClosurePort();
  const first = submissionInput({
    journal,
    closurePort,
    checkpoint: checkpoint(1, null, { summary: 'first summary' }),
  });
  await submitCheckpoint(first);

  const conflicting = submissionInput({
    journal,
    closurePort,
    checkpoint: checkpoint(1, null, { summary: 'different summary' }),
  });
  await assert.rejects(() => submitCheckpoint(conflicting), CheckpointSubmissionError);
  assert.equal(journal.appended.length, 1);
});

test('same checkpoint value in different scopes keeps commit and closure identities isolated', async () => {
  const journal = new FakeJournal();
  const closurePort = new FakeClosurePort();
  const otherScope: ScopeRef = {
    organId: organ,
    taskId: id('task', 'task-b'),
    cycleId: id('cycle', 'cycle-b'),
    operationId: id('operation', 'operation-b'),
  };
  const first = checkpoint(1, null);
  const second = checkpoint(1, null, {
    scope: otherScope,
    cycleId: otherScope.cycleId!,
    recoveryStateRef: evidence('recovery-1', otherScope),
    evidenceRefs: [evidence('completion-1', otherScope)],
  });

  assert.equal(checkpointCommitId(first) === checkpointCommitId(second), false);
  await submitCheckpoint({ ...submissionInput(), checkpoint: first, journal, closurePort });
  await submitCheckpoint({ ...submissionInput(), checkpoint: second, journal, closurePort });

  assert.equal(journal.appended.length, 2);
  assert.equal(closurePort.committed.length, 2);
  const closureIds = closurePort.committed.map((record) => 'closureId' in record ? record.closureId : record.deadEndRef);
  assert.equal(closureIds[0] === closureIds[1], false);
});

test('legacy checkpoint closure ids remain readable for submission retries and reentry', async () => {
  const input = submissionInput();
  await input.journal.append({
    ownerId: 'task-owner',
    commitId: checkpointCommitId(input.checkpoint),
    checkpoint: input.checkpoint,
  });
  input.closurePort.records.set(`checkpoint-closure:${input.checkpoint.id.value}`, {
    closureKind: 'checkpoint',
    closureId: `checkpoint-closure:${input.checkpoint.id.value}`,
    checkpointId: input.checkpoint.id,
    source: 'agent-tool',
    outcome: input.checkpoint.outcome,
    summary: input.checkpoint.summary,
    next: input.checkpoint.next,
    evidenceRefs: input.checkpoint.evidenceRefs,
    reentry: { allowed: true, reason: 'waiting checkpoint can be reentered from its recovery condition' },
  });

  const retried = await submitCheckpoint(input);
  assert.equal(retried.state, 'committed');
  assert.equal(input.closurePort.committed.length, 0);

  const reentry = await commitReentry({
    ownerId: 'task-owner',
    closureId: 'reentry-from-legacy-closure',
    checkpoint: input.checkpoint,
    previousExecutionEpoch: input.checkpoint.executionEpoch,
    newExecutionEpoch: input.checkpoint.executionEpoch + 1,
    nextAction: { kind: 'continue', ref: 'after-legacy-reentry' },
    journal: input.journal,
    closurePort: input.closurePort,
    admissionPort: new FakeAdmissionPort(),
  });
  assert.equal(reentry.state, 'committed');
  assert.equal(input.closurePort.committed.length, 1);
});

test('checkpoint submission rejects a committed closure that does not match the checkpoint', async () => {
  const input = submissionInput();
  input.closurePort.records.set(`checkpoint-closure:${checkpointCommitId(input.checkpoint)}`, {
    closureKind: 'checkpoint',
    closureId: `checkpoint-closure:${checkpointCommitId(input.checkpoint)}`,
    checkpointId: input.checkpoint.id,
    source: 'agent-tool',
    outcome: 'succeeded',
    summary: 'different summary',
    next: { kind: 'continue', ref: 'other' },
    evidenceRefs: input.checkpoint.evidenceRefs,
    reentry: { allowed: true, reason: 'different closure' },
  });

  await assert.rejects(() => submitCheckpoint(input), CheckpointSubmissionError);
  assert.equal(input.journal.appended.length, 0);
});

test('unknown-operation reconcile rejects unresolved evidence gaps and out-of-scope operations before journal append', async () => {
  const missingEvidence = submissionInput({
    unknownOperations: [operation],
    reconciledOperations: [{ operationId: operation, state: 'reconciled' }],
  });
  await assert.rejects(() => submitCheckpoint(missingEvidence), CheckpointSubmissionError);
  assert.equal(missingEvidence.journal.appended.length, 0);

  const outOfScopeOperation = id('operation', 'operation-other');
  const outOfScope = submissionInput({ unknownOperations: [outOfScopeOperation] });
  await assert.rejects(() => submitCheckpoint(outOfScope), CheckpointSubmissionError);
  assert.equal(outOfScope.journal.appended.length, 0);
});

test('interaction closure requires evidence and rejects task checkpoint scopes', async () => {
  await assert.rejects(
    () => submitInteractionClosure({
      ownerId: 'interaction-owner',
      closureId: 'interaction-no-evidence',
      scope: interactionScope,
      reason: 'closed without evidence',
      evidenceRefs: [],
      closurePort: new FakeClosurePort(),
    }),
    CheckpointSubmissionError,
  );

  await assert.rejects(
    () => submitInteractionClosure({
      ownerId: 'interaction-owner',
      closureId: 'interaction-task-scope',
      scope,
      reason: 'should not close as task checkpoint',
      evidenceRefs: [evidence('interaction-task-scope')],
      closurePort: new FakeClosurePort(),
    }),
    CheckpointSubmissionError,
  );
});

test('dead-end closure requires failed paths, invalidated assumptions, and scoped evidence', async () => {
  await assert.rejects(
    () => commitDeadEnd({
      ownerId: 'task-owner',
      record: {
        deadEndRef: 'dead-end-bad',
        scope,
        failedPathRefs: [],
        conclusion: 'no failed path',
        invalidatedAssumptions: ['assumption-a'],
        evidenceRefs: [evidence('dead-end-bad')],
      },
      closurePort: new FakeClosurePort(),
    }),
    CheckpointSubmissionError,
  );

  await assert.rejects(
    () => commitDeadEnd({
      ownerId: 'task-owner',
      record: {
        deadEndRef: 'dead-end-out-of-scope',
        scope,
        failedPathRefs: ['branch-a'],
        conclusion: 'branch a is invalid',
        invalidatedAssumptions: ['assumption-a'],
        evidenceRefs: [{ ...evidence('dead-end-out-of-scope'), scope: { ...scope, organId: id('organ', 'organ-b') } }],
      },
      closurePort: new FakeClosurePort(),
    }),
    CheckpointSubmissionError,
  );
});

test('reentry rejects wrong checkpoint epoch, non-increasing epoch, and non-reentry next action', async () => {
  const committedCheckpoint = checkpoint(1, null);
  const journal = new FakeJournal();
  const closurePort = new FakeClosurePort();
  const admissionPort = new FakeAdmissionPort();
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId: 'task-owner',
    checkpoint: committedCheckpoint,
    previous: null,
    journal,
    closurePort,
  });
  const base = {
    ownerId: 'task-owner',
    checkpoint: committedCheckpoint,
    journal,
    closurePort,
    admissionPort,
    nextAction: { kind: 'continue' as const, ref: 'after-dead-end' },
  };

  await assert.rejects(
    () => commitReentry({
      ...base,
      closureId: 'reentry-wrong-checkpoint-epoch',
      previousExecutionEpoch: 3,
      newExecutionEpoch: 5,
    }),
    CheckpointSubmissionError,
  );
  await assert.rejects(
    () => commitReentry({
      ...base,
      closureId: 'reentry-same-epoch',
      previousExecutionEpoch: 4,
      newExecutionEpoch: 4,
    }),
    CheckpointSubmissionError,
  );
  await assert.rejects(
    () => commitReentry({
      ...base,
      closureId: 'reentry-stop-next',
      previousExecutionEpoch: 4,
      newExecutionEpoch: 5,
      nextAction: { kind: 'stop', ref: 'stop-instead-of-reentry' },
    }),
    CheckpointSubmissionError,
  );
});

test('reentry rejects missing committed closure, wrong checkpoint identity, stale epochs, and denied admission', async () => {
  const committedCheckpoint = checkpoint(1, null);
  const journal = new FakeJournal();
  const closurePort = new FakeClosurePort();
  const admissionPort = new FakeAdmissionPort();
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId: 'task-owner',
    checkpoint: committedCheckpoint,
    previous: null,
    journal,
    closurePort,
  });
  const base = {
    ownerId: 'task-owner',
    checkpoint: committedCheckpoint,
    journal,
    closurePort,
    admissionPort,
    nextAction: { kind: 'continue' as const, ref: 'after-reentry' },
  };

  const noClosureJournal = new FakeJournal();
  const noClosurePort = new FakeClosurePort();
  await noClosureJournal.append({
    ownerId: 'task-owner',
    commitId: checkpointCommitId(committedCheckpoint),
    checkpoint: committedCheckpoint,
  });
  await assert.rejects(
    () => commitReentry({
      ...base,
      journal: noClosureJournal,
      closurePort: noClosurePort,
      closureId: 'reentry-no-closure',
      previousExecutionEpoch: 4,
      newExecutionEpoch: 5,
    }),
    CheckpointSubmissionError,
  );

  const wrongCheckpoint = checkpoint(2, committedCheckpoint.id, { id: id('checkpoint', 'checkpoint-other') });
  await assert.rejects(
    () => commitReentry({
      ...base,
      checkpoint: wrongCheckpoint,
      closureId: 'reentry-wrong-identity',
      previousExecutionEpoch: 4,
      newExecutionEpoch: 5,
    }),
    CheckpointSubmissionError,
  );

  await assert.rejects(
    () => commitReentry({
      ...base,
      closureId: 'reentry-stale-old-epoch',
      previousExecutionEpoch: 3,
      newExecutionEpoch: 5,
    }),
    CheckpointSubmissionError,
  );

  admissionPort.decision = {
    allowed: false,
    reason: 'permission revoked and resources are not admitted',
    blockedBy: ['permission-revoked', 'resource-admission'],
  };
  await assert.rejects(
    () => commitReentry({
      ...base,
      closureId: 'reentry-admission-denied',
      previousExecutionEpoch: 4,
      newExecutionEpoch: 5,
    }),
    CheckpointSubmissionError,
  );
  assert.equal(closurePort.committed.length, 1);
});
