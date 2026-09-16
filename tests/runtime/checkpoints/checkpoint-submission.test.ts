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
  latest: LatestCheckpointRecord | null = null;
  appended: CheckpointAppendRequest[] = [];

  async verify(): Promise<CheckpointChainVerification> {
    return this.verification;
  }

  async readLatest(): Promise<LatestCheckpointRecord | null> {
    return this.latest;
  }

  async append(input: CheckpointAppendRequest): Promise<CheckpointAppendReceipt> {
    this.appended.push(input);
    return { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq };
  }
}

class FakeClosurePort implements CheckpointClosurePort {
  readonly committed: ClosureRecord[] = [];

  async commit(input: ClosureRecord): Promise<{ readonly closureId: string; readonly committed: true }> {
    const closureId = 'closureId' in input
      ? (input as { readonly closureId: string }).closureId
      : 'deadEndRef' in input
        ? (input as DeadEndRecord).deadEndRef
        : 'unknown-closure';
    this.committed.push(input);
    return { closureId, committed: true };
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
  const context = {
    ownerId: 'task-owner',
    source: 'agent-tool' as const,
    journal: new FakeJournal(),
    closurePort: new FakeClosurePort(),
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

  const reentry = await reenterCheckpointTool(context, {
    closureId: 'reentry-a',
    checkpoint: checkpoint(1, null),
    previousExecutionEpoch: 4,
    newExecutionEpoch: 5,
    deadEndRef: 'dead-end-a',
    nextAction: { kind: 'continue', ref: 'after-dead-end' },
  });
  assert.equal(reentry.state, 'committed');
  assert.equal(reentry.record.reentry.allowed, true);
});

test('checkpoint.save tool exposes committed versus blocked outcomes without bypassing unified submission', async () => {
  const context = {
    ownerId: 'task-owner',
    source: 'harness-control' as const,
    journal: new FakeJournal(),
    closurePort: new FakeClosurePort(),
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
  assert.equal(saved.outcome, 'rejected');
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
  const base = {
    ownerId: 'task-owner',
    checkpointId: checkpoint(1, null).id,
    checkpointExecutionEpoch: 4,
    closurePort: new FakeClosurePort(),
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
