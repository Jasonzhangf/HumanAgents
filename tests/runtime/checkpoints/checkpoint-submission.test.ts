import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type Checkpoint,
  type ContextHistoryRecord,
  type EvidenceRef,
  type JournalCommitRef,
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
  ConditionalReentrySubmissionPort,
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
  CHECKPOINT_CLOSURE_COMPATIBILITY,
  assertSupportedCheckpointClosureCompatibilityVersion,
  submitCheckpoint,
  submitInteractionClosure,
  type SubmitCheckpointInput,
} from '../../../packages/runtime/src/checkpoints/submission.js';
import { checkpointCommitId, durableContextDigest } from '../../../packages/runtime/src/checkpoints/coordinator.js';
import { reconcileUnknownOperations } from '../../../packages/runtime/src/checkpoints/closure.js';
import {
  buildConditionalReentry,
  type ConfirmedReentryCommand,
  type ConditionalReentryRecord,
  type ReentryCurrentFacts,
} from '../../../packages/runtime/src/checkpoints/conditional-reentry.js';
import {
  CheckpointSubmissionError,
} from '../../../packages/runtime/src/checkpoints/errors.js';
import { assertReentryRecord } from '../../../packages/runtime/src/checkpoints/closure.js';
import { assertConditionalReentryRecord } from '../../../packages/runtime/src/checkpoints/conditional-reentry.js';
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

  async readCommitted(
    ..._args: Parameters<CheckpointJournalPort['readCommitted']>
  ): ReturnType<CheckpointJournalPort['readCommitted']> {
    throw new Error('FakeJournal.readCommitted is unsupported in this fixture');
  }

  async listCommitted(
    ..._args: Parameters<CheckpointJournalPort['listCommitted']>
  ): ReturnType<CheckpointJournalPort['listCommitted']> {
    throw new Error('FakeJournal.listCommitted is unsupported in this fixture');
  }

  async readExecutionPosition(
    ..._args: Parameters<CheckpointJournalPort['readExecutionPosition']>
  ): ReturnType<CheckpointJournalPort['readExecutionPosition']> {
    throw new Error('FakeJournal.readExecutionPosition is unsupported in this fixture');
  }

  async readCheckpointRecoveryBinding(
    ..._args: Parameters<CheckpointJournalPort['readCheckpointRecoveryBinding']>
  ): ReturnType<CheckpointJournalPort['readCheckpointRecoveryBinding']> {
    throw new Error('FakeJournal.readCheckpointRecoveryBinding is unsupported in this fixture');
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

function journalCommitRef(name: string, journalSeq: number): JournalCommitRef {
  return { commitId: `commit-${name}`, journalSeq, recordDigest: `sha256:${name}` };
}

interface ConditionalReentryFixture {
  readonly taskScope: ScopeRef;
  readonly command: ConfirmedReentryCommand;
  readonly prepared: ConditionalReentryRecord;
  readonly preparedCommands: ConfirmedReentryCommand[];
  readonly commits: Array<{ readonly record: ConditionalReentryRecord; readonly expected: JournalCommitRef }>;
  readonly reads: Array<{ readonly scope: ScopeRef; readonly commandId: string }>;
  readonly port: ConditionalReentrySubmissionPort;
}

/**
 * Minimal in-file conditional reentry fixture. It reuses the production builder
 * and the ConditionalReentrySubmissionPort seam so the reentry cases exercise
 * the Runtime contract instead of the legacy read-only gate. The double keeps
 * the first committed record per command id: an exact retry reads that record
 * back (idempotent), while a changed command under the same id fails the exact
 * readback comparison in commitReentry.
 */
function conditionalReentryFixture(committedCheckpoint: Checkpoint, sourceClosureRef: string): ConditionalReentryFixture {
  const taskScope: ScopeRef = { organId: organ, taskId: task };
  const contextHistory = (agentRuntimeId: string, executionEpoch: number, suffix: string): ContextHistoryRecord => {
    const checkpointRef = { checkpointId: id('checkpoint', `loop-${suffix}`), digest: `sha256:loop-${suffix}` };
    const observationScopeId = `observation-${suffix}`;
    const durableContext = { stablePrefix: [{ goal: 'resume confirmed path' }], indexRefs: [], dynamicHead: [], repairRefs: [] };
    return {
      kind: 'context-history',
      schemaVersion: 1,
      scope: taskScope,
      agentRuntimeId,
      contextView: {
        contextViewRef: `context-${suffix}`,
        executionEpoch,
        checkpoint: checkpointRef,
        contextDigest: `sha256:context-${suffix}`,
        activeRefs: ['task:goal'],
        omittedRefs: [],
      },
      loopCheckpoint: {
        ...checkpointRef,
        sequence: 1,
        executionEpoch,
        observationScopeId,
        contextViewRef: `context-${suffix}`,
        eventWatermark: { streamId: `stream-${suffix}`, sequence: 0 },
        predecessor: null,
      },
      replacement: null,
      previousContextCommitRef: null,
      durableContext,
      durableContextDigest: durableContextDigest(durableContext),
      loopControl: {
        mode: 'orchestration',
        transitionSeq: 1,
        observationScopeId,
        observationScope: null,
        inboxStreamId: `stream-${suffix}`,
        inboxExecutionEpoch: executionEpoch,
        inboxCheckpoint: checkpointRef,
        inboxObservationScopeId: observationScopeId,
        inboxWatermark: 0,
        handledEventIds: [],
        handledBatchKeys: [],
        deltaExecutionEpoch: executionEpoch,
        deltaCheckpoint: checkpointRef,
        deltaObservationScopeId: observationScopeId,
        deltaWatermark: { streamId: `stream-${suffix}`, sequence: 0 },
        appliedDeltaIds: [],
        appliedDeltaKeys: [],
        closedObservationScopeIds: [],
        budgetUsage: { modeTransitions: 0, observationScopes: 0, contextReplacements: 0, deferredEvents: 0 },
      },
    };
  };
  const command: ConfirmedReentryCommand = {
    commandId: 'reentry-conditional',
    taskScope,
    targetCheckpointCommitRef: journalCommitRef('target-checkpoint', 1),
    expectedCurrentControlCommitRef: journalCommitRef('current-control', 2),
    expectedExecutionEpoch: committedCheckpoint.executionEpoch,
    expectedOperationControlCommitRef: journalCommitRef('operation-control', 3),
    expectedGrantCommitRef: journalCommitRef('grant', 4),
    permissionRevision: 'permission-revision-a',
    confirmationRef: 'confirmation-a',
    principalOwner: 'task-owner',
  };
  const targetContext = contextHistory('runtime-target', committedCheckpoint.executionEpoch, 'target');
  const currentContext = contextHistory('runtime-current', committedCheckpoint.executionEpoch, 'current');
  const current: ReentryCurrentFacts = {
    state: 'known',
    stateCommitRef: journalCommitRef('state', 5),
    task: {
      id: task,
      organId: organ,
      title: 'reentry task',
      directive: 'continue the confirmed path',
      directiveRevision: 2,
      state: 'waiting',
      memoryScope: 'task',
    },
    position: {
      checkpointCommitRef: command.targetCheckpointCommitRef,
      contextCommitRef: journalCommitRef('current-context', 6),
      executionEpoch: committedCheckpoint.executionEpoch,
      controlCommitRef: command.expectedCurrentControlCommitRef,
    },
    context: currentContext,
    entryPhase: 'orchestration',
    nextAction: 'continue:after-reentry',
    fencedBindings: [{
      scope: taskScope,
      agentRuntimeId: currentContext.agentRuntimeId,
      executionEpoch: committedCheckpoint.executionEpoch,
    }],
    retainedDuties: [],
    unresolvedDisplacedRefs: [],
  };
  const buildInput = {
    command,
    targetScope: taskScope,
    targetContext,
    targetClosure: {
      checkpointId: committedCheckpoint.id,
      source: 'agent-tool' as const,
      closureReason: 'confirmed reentry target',
      executionEpoch: committedCheckpoint.executionEpoch,
      committed: true,
      reentryAllowed: true,
      pendingOperations: [],
      unknownOperations: [],
      recoveryStateRef: committedCheckpoint.recoveryStateRef,
      nextAction: { kind: 'continue' as const, ref: 'after-reentry' },
      closedAt: '2026-10-15T00:00:00.000Z',
    },
    sourceContextCommitRef: journalCommitRef('target-context', 7),
    sourceClosureRef,
    current,
    maxExecutionEpoch: committedCheckpoint.executionEpoch,
  };
  const prepared = buildConditionalReentry(buildInput);
  const preparedCommands: ConfirmedReentryCommand[] = [];
  const commits: ConditionalReentryFixture['commits'] = [];
  const reads: ConditionalReentryFixture['reads'] = [];
  const committedByCommand = new Map<string, { readonly record: ConditionalReentryRecord; readonly commitRef: JournalCommitRef }>();
  const port: ConditionalReentrySubmissionPort = {
    async prepare(received) {
      preparedCommands.push(received);
      return buildConditionalReentry({ ...buildInput, command: received });
    },
    async commitReentryRecord(record, expected) {
      const existing = committedByCommand.get(record.command.commandId);
      if (existing) return existing.commitRef;
      const commitRef = journalCommitRef('conditional-reentry', 8);
      committedByCommand.set(record.command.commandId, { record, commitRef });
      commits.push({ record, expected });
      return commitRef;
    },
    async readReentry(readScope, commandId) {
      reads.push({ scope: readScope, commandId });
      const entry = committedByCommand.get(commandId);
      return entry ? { record: entry.record, commitRef: entry.commitRef } : null;
    },
  };
  return { taskScope, command, prepared, preparedCommands, commits, reads, port };
}

/**
 * A conditional reentry port whose prepare runs the real production validators
 * against a caller-supplied record. The negative cases therefore fail inside the
 * Runtime contract instead of the legacy entry gate. Commit and readback stay
 * unreachable because preparation must reject first.
 */
function preparedValidationPort(
  record: ConditionalReentryRecord,
  validation: { readonly targetExecutionEpoch?: number; readonly currentExecutionEpoch?: number } = {},
): ConditionalReentrySubmissionPort {
  return {
    async prepare() {
      assertReentryRecord(record);
      assertConditionalReentryRecord({
        record,
        targetExecutionEpoch: validation.targetExecutionEpoch ?? record.checkpointExecutionEpoch,
        currentExecutionEpoch: validation.currentExecutionEpoch ?? record.previousExecutionEpoch,
        permissionRevision: record.coreReentry.permissionRevision,
        command: record.command,
        restoredContext: record.restoredContext,
      });
      return record;
    },
    async commitReentryRecord() {
      throw new Error('unreachable: preparation must reject before commit');
    },
    async readReentry() {
      throw new Error('unreachable: preparation must reject before readback');
    },
  };
}

/**
 * Assert that a rejection happens and that its message matches a pattern. The
 * shared Node ambient types reject the RegExp overload of assert.rejects, so the
 * message is captured and matched with the declared assert.equal.
 */
async function rejectsWithMessage(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let message: string | null = null;
  try {
    await fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.equal(message === null, false, `expected a rejection matching ${pattern}`);
  assert.equal(pattern.test(message ?? ''), true, `rejection message did not match ${pattern}: ${message}`);
}

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
  const originalClosureIds = closurePort.committed.map((record) =>
    'closureId' in record ? record.closureId : record.deadEndRef);
  assert.deepEqual(originalClosureIds, [
    'dead-end-a',
    `checkpoint-closure:${checkpointCommitId(committedCheckpoint)}`,
  ]);

  const canonicalRef = `checkpoint-closure:${checkpointCommitId(committedCheckpoint)}`;
  const { taskScope, command, port, preparedCommands, commits, reads } =
    conditionalReentryFixture(committedCheckpoint, canonicalRef);

  const reentry = await reenterCheckpointTool(context, { port, command });
  assert.equal(reentry.state, 'committed');
  assert.equal(reentry.record.reentry.allowed, true);
  assert.equal(preparedCommands.length, 1);
  assert.equal(preparedCommands[0], command);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0]?.expected, command.expectedCurrentControlCommitRef);
  assert.deepEqual(reads, [{ scope: taskScope, commandId: command.commandId }]);
  assert.equal(admissionPort.calls.length, 0);
  assert.deepEqual(closurePort.committed.map((record) =>
    'closureId' in record ? record.closureId : record.deadEndRef), originalClosureIds);
});

test('reentry retries are idempotent and reject a reused closure id with different content', async () => {
  const journal = new FakeJournal();
  const closurePort = new FakeClosurePort();
  const committedCheckpoint = checkpoint(1, null);
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId: 'task-owner',
    checkpoint: committedCheckpoint,
    previous: null,
    journal,
    closurePort,
  });
  const canonicalRef = `checkpoint-closure:${checkpointCommitId(committedCheckpoint)}`;
  const { taskScope, command, port, commits, reads } = conditionalReentryFixture(committedCheckpoint, canonicalRef);

  const first = await commitReentry({ ownerId: 'task-owner', conditional: { port, command } });
  assert.equal(first.state, 'committed');

  // An exact retry under the same command id reuses the first committed fact
  // without appending a second one, even though the journal has moved on.
  journal.latest = {
    checkpoint: checkpoint(2, committedCheckpoint.id, { id: id('checkpoint', 'checkpoint-later') }),
    previous: committedCheckpoint,
  };
  const retry = await commitReentry({ ownerId: 'task-owner', conditional: { port, command } });
  assert.deepEqual(retry, first);
  assert.equal(commits.length, 1);
  assert.equal(closurePort.committed.length, 1);

  // The same command id with changed confirmed content is rejected by the exact
  // readback comparison instead of overwriting the first committed record.
  const conflictingCommand: ConfirmedReentryCommand = { ...command, confirmationRef: 'confirmation-conflict' };
  await rejectsWithMessage(
    () => commitReentry({ ownerId: 'task-owner', conditional: { port, command: conflictingCommand } }),
    /reentry exact readback is absent or different/,
  );
  assert.equal(commits.length, 1);
  assert.equal(closurePort.committed.length, 1);
  assert.deepEqual(reads, [
    { scope: taskScope, commandId: command.commandId },
    { scope: taskScope, commandId: command.commandId },
    { scope: taskScope, commandId: command.commandId },
  ]);
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
  assert.equal(closureIds[0], `checkpoint-closure:${checkpointCommitId(first)}`);
  assert.equal(closureIds[0] === closureIds[1], false);
});

test('legacy checkpoint closure ids remain readable for submission retries and reentry', async () => {
  const input = submissionInput();
  assert.equal(CHECKPOINT_CLOSURE_COMPATIBILITY.legacy.version, 1);
  assert.equal(CHECKPOINT_CLOSURE_COMPATIBILITY.legacy.scope, 'checkpoint-id');
  const legacyClosureId = `checkpoint-closure:${input.checkpoint.id.value}`;
  await input.journal.append({
    ownerId: 'task-owner',
    commitId: checkpointCommitId(input.checkpoint),
    checkpoint: input.checkpoint,
  });
  input.closurePort.records.set(legacyClosureId, {
    closureKind: 'checkpoint',
    compatibilityVersion: CHECKPOINT_CLOSURE_COMPATIBILITY.legacy.version,
    closureId: legacyClosureId,
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

  // Reading a legacy closure never authorizes an unbound mutation.
  await rejectsWithMessage(
    () => commitReentry({
      ownerId: 'task-owner',
      closureId: 'reentry-from-legacy-closure',
      checkpoint: input.checkpoint,
      previousExecutionEpoch: input.checkpoint.executionEpoch,
      newExecutionEpoch: input.checkpoint.executionEpoch + 1,
      nextAction: { kind: 'continue', ref: 'after-legacy-reentry' },
      journal: input.journal,
      closurePort: input.closurePort,
      admissionPort: new FakeAdmissionPort(),
    }),
    /legacy unbound reentry is read-only/,
  );

  // A confirmed conditional command may reuse the decoded legacy closure as its source.
  const { command, port, commits } = conditionalReentryFixture(input.checkpoint, legacyClosureId);
  const committed = await commitReentry({ ownerId: 'task-owner', conditional: { port, command } });
  assert.equal(committed.state, 'committed');
  assert.equal(committed.record.sourceClosureRef, legacyClosureId);
  assert.equal(commits.length, 1);
  assert.equal(input.closurePort.committed.length, 0);
});

test('pre-version legacy checkpoint closures infer v1 for retry and reentry', async () => {
  const input = submissionInput();
  const legacyId = `checkpoint-closure:${input.checkpoint.id.value}`;
  await input.journal.append({
    ownerId: 'task-owner',
    commitId: checkpointCommitId(input.checkpoint),
    checkpoint: input.checkpoint,
  });
  input.closurePort.records.set(legacyId, {
    closureKind: 'checkpoint',
    closureId: legacyId,
    checkpointId: input.checkpoint.id,
    source: 'agent-tool',
    outcome: input.checkpoint.outcome,
    summary: input.checkpoint.summary,
    next: input.checkpoint.next,
    evidenceRefs: input.checkpoint.evidenceRefs,
    reentry: { allowed: true, reason: 'waiting checkpoint can be reentered from its recovery condition' },
  } as CheckpointClosureRecord);

  const retried = await submitCheckpoint(input);
  assert.equal(retried.state, 'committed');
  assert.equal(retried.closure.compatibilityVersion, undefined);

  const { command, port, commits } = conditionalReentryFixture(input.checkpoint, legacyId);
  const reentry = await commitReentry({ ownerId: 'task-owner', conditional: { port, command } });
  assert.equal(reentry.state, 'committed');
  assert.equal(reentry.record.sourceClosureRef, legacyId);
  assert.equal(commits.length, 1);
  assert.equal(input.closurePort.committed.length, 0);
});

test('legacy checkpoint closure mismatches fail explicitly without canonical fallback', async () => {
  const input = submissionInput();
  const legacyId = `checkpoint-closure:${input.checkpoint.id.value}`;
  input.closurePort.records.set(legacyId, {
    closureKind: 'checkpoint',
    compatibilityVersion: CHECKPOINT_CLOSURE_COMPATIBILITY.legacy.version,
    closureId: legacyId,
    checkpointId: input.checkpoint.id,
    source: 'agent-tool',
    outcome: input.checkpoint.outcome,
    summary: 'different legacy summary',
    next: input.checkpoint.next,
    evidenceRefs: input.checkpoint.evidenceRefs,
    reentry: { allowed: true, reason: 'mismatched legacy closure' },
  });

  await assert.rejects(async () => {
    try {
      await submitCheckpoint(input);
    } catch (error) {
      assert.equal((error as Error).message, 'legacy checkpoint closure v1 does not match the checkpoint');
      throw error;
    }
  });
  assert.equal(input.journal.appended.length, 0);
  assert.equal(input.closurePort.committed.length, 0);
});

test('unsupported persisted checkpoint closure versions fail before Journal append or commit', async () => {
  const input = submissionInput();
  const legacyId = `checkpoint-closure:${input.checkpoint.id.value}`;
  input.closurePort.records.set(legacyId, {
    closureKind: 'checkpoint',
    compatibilityVersion: 3 as never,
    closureId: legacyId,
    checkpointId: input.checkpoint.id,
    source: 'agent-tool',
    outcome: input.checkpoint.outcome,
    summary: input.checkpoint.summary,
    next: input.checkpoint.next,
    evidenceRefs: input.checkpoint.evidenceRefs,
    reentry: { allowed: true, reason: 'unsupported persisted version' },
  });

  await assert.rejects(async () => {
    try {
      await submitCheckpoint(input);
    } catch (error) {
      assert.equal((error as Error).message, 'unsupported checkpoint closure compatibility version: 3');
      throw error;
    }
  });
  assert.equal(input.journal.appended.length, 0);
  assert.equal(input.closurePort.committed.length, 0);
});

test('checkpoint closure compatibility declares the sunset boundary and rejects unsupported versions', () => {
  assert.equal(CHECKPOINT_CLOSURE_COMPATIBILITY.current.version, 2);
  assert.equal(CHECKPOINT_CLOSURE_COMPATIBILITY.current.scope, 'checkpoint-commit-id');
  assert.equal(CHECKPOINT_CLOSURE_COMPATIBILITY.legacy.sunsetCondition.includes('remove after'), true);
  assert.throws(
    () => {
      try {
        assertSupportedCheckpointClosureCompatibilityVersion(3);
      } catch (error) {
        assert.equal((error as Error).message, 'unsupported checkpoint closure compatibility version: 3');
        throw error;
      }
    },
    CheckpointSubmissionError,
  );
});

test('checkpoint submission rejects a committed closure that does not match the checkpoint', async () => {
  const input = submissionInput();
  input.closurePort.records.set(`checkpoint-closure:${checkpointCommitId(input.checkpoint)}`, {
    closureKind: 'checkpoint',
    compatibilityVersion: CHECKPOINT_CLOSURE_COMPATIBILITY.current.version,
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

test('pre-version canonical checkpoint closures infer v2 for retry and reentry', async () => {
  const input = submissionInput();
  const canonicalId = `checkpoint-closure:${checkpointCommitId(input.checkpoint)}`;
  await input.journal.append({
    ownerId: 'task-owner',
    commitId: checkpointCommitId(input.checkpoint),
    checkpoint: input.checkpoint,
  });
  input.closurePort.records.set(canonicalId, {
    closureKind: 'checkpoint',
    closureId: canonicalId,
    checkpointId: input.checkpoint.id,
    source: 'agent-tool',
    outcome: input.checkpoint.outcome,
    summary: input.checkpoint.summary,
    next: input.checkpoint.next,
    evidenceRefs: input.checkpoint.evidenceRefs,
    reentry: { allowed: true, reason: 'waiting checkpoint can be reentered from its recovery condition' },
  } as CheckpointClosureRecord);

  const retried = await submitCheckpoint(input);
  assert.equal(retried.state, 'committed');
  assert.equal(retried.closure.compatibilityVersion, undefined);

  const { command, port, commits } = conditionalReentryFixture(input.checkpoint, canonicalId);
  const reentry = await commitReentry({ ownerId: 'task-owner', conditional: { port, command } });
  assert.equal(reentry.state, 'committed');
  assert.equal(reentry.record.sourceClosureRef, canonicalId);
  assert.equal(commits.length, 1);
  assert.equal(input.closurePort.committed.length, 0);
});

test('checkpoint submission rejects a canonical closure whose stored identity does not match its key', async () => {
  const input = submissionInput();
  const canonicalId = `checkpoint-closure:${checkpointCommitId(input.checkpoint)}`;
  input.journal.latest = { checkpoint: input.checkpoint, previous: null };
  input.closurePort.records.set(canonicalId, {
    closureKind: 'checkpoint',
    compatibilityVersion: CHECKPOINT_CLOSURE_COMPATIBILITY.current.version,
    closureId: 'checkpoint-closure:wrong-identity',
    checkpointId: input.checkpoint.id,
    source: 'agent-tool',
    outcome: input.checkpoint.outcome,
    summary: input.checkpoint.summary,
    next: input.checkpoint.next,
    evidenceRefs: input.checkpoint.evidenceRefs,
    reentry: { allowed: true, reason: 'wrong stored identity' },
  });

  let failure: unknown;
  try {
    await submitCheckpoint(input);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure instanceof CheckpointSubmissionError, true);
  assert.equal((failure as Error).message, 'checkpoint closure identity does not match its canonical key');
  assert.equal(input.journal.appended.length, 0);
  assert.equal(input.closurePort.committed.length, 0);
  assert.equal(input.closurePort.records.has(canonicalId), true);
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
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId: 'task-owner',
    checkpoint: committedCheckpoint,
    previous: null,
    journal,
    closurePort,
  });
  const canonicalRef = `checkpoint-closure:${checkpointCommitId(committedCheckpoint)}`;
  const { command, prepared, commits } = conditionalReentryFixture(committedCheckpoint, canonicalRef);

  // The target epoch must match the committed target recovered under the lock.
  await rejectsWithMessage(
    () => commitReentry({
      ownerId: 'task-owner',
      conditional: { port: preparedValidationPort(prepared, { targetExecutionEpoch: prepared.checkpointExecutionEpoch + 1 }), command },
    }),
    /target epoch must match/,
  );
  // The new execution epoch must exceed the displaced epoch.
  await rejectsWithMessage(
    () => commitReentry({
      ownerId: 'task-owner',
      conditional: { port: preparedValidationPort({ ...prepared, newExecutionEpoch: prepared.previousExecutionEpoch }), command },
    }),
    /must create a new execution epoch/,
  );
  // A next action that does not allow reentry is rejected.
  await rejectsWithMessage(
    () => commitReentry({
      ownerId: 'task-owner',
      conditional: { port: preparedValidationPort({ ...prepared, nextAction: { kind: 'stop', ref: 'stop-instead-of-reentry' } }), command },
    }),
    /reentry next action must allow reentry/,
  );
  assert.equal(commits.length, 0);
  assert.equal(closurePort.committed.length, 1);
});

test('reentry rejects missing committed closure, wrong checkpoint identity, stale epochs, and denied admission', async () => {
  const committedCheckpoint = checkpoint(1, null);
  const journal = new FakeJournal();
  const closurePort = new FakeClosurePort();
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId: 'task-owner',
    checkpoint: committedCheckpoint,
    previous: null,
    journal,
    closurePort,
  });
  const canonicalRef = `checkpoint-closure:${checkpointCommitId(committedCheckpoint)}`;
  const { command, prepared, port } = conditionalReentryFixture(committedCheckpoint, canonicalRef);

  // Missing committed reentry: the port commits but the exact readback is absent.
  await rejectsWithMessage(
    () => commitReentry({
      ownerId: 'task-owner',
      conditional: { port: { ...port, async readReentry() { return null; } }, command },
    }),
    /reentry exact readback is absent or different/,
  );
  // Wrong committed identity: the readback returns a different record.
  await rejectsWithMessage(
    () => commitReentry({
      ownerId: 'task-owner',
      conditional: {
        port: {
          ...port,
          async readReentry() {
            return { record: { ...prepared, newExecutionEpoch: prepared.newExecutionEpoch + 1 }, commitRef: journalCommitRef('different', 9) };
          },
        },
        command,
      },
    }),
    /reentry exact readback is absent or different/,
  );
  // A stale displaced epoch must not be treated as the current position.
  await rejectsWithMessage(
    () => commitReentry({
      ownerId: 'task-owner',
      conditional: { port: preparedValidationPort(prepared, { currentExecutionEpoch: prepared.previousExecutionEpoch + 1 }), command },
    }),
    /displaced epoch must match/,
  );
  // A fence at or above the new execution epoch is rejected.
  await rejectsWithMessage(
    () => commitReentry({
      ownerId: 'task-owner',
      conditional: {
        port: preparedValidationPort({
          ...prepared,
          fencedBindings: prepared.fencedBindings.map((fence) => ({ ...fence, executionEpoch: prepared.newExecutionEpoch })),
        }),
        command,
      },
    }),
    /must fence epochs below/,
  );
  assert.equal(closurePort.committed.length, 1);
});

test('reentry rejects a canonical closure that mismatches the committed checkpoint before admission', async () => {
  const committedCheckpoint = checkpoint(1, null);
  const journal = new FakeJournal();
  const closurePort = new FakeClosurePort();
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId: 'task-owner',
    checkpoint: committedCheckpoint,
    previous: null,
    journal,
    closurePort,
  });
  const canonicalId = `checkpoint-closure:${checkpointCommitId(committedCheckpoint)}`;
  const { command, prepared } = conditionalReentryFixture(committedCheckpoint, canonicalId);
  const tamperedCommand: ConfirmedReentryCommand = { ...command, confirmationRef: 'confirmation-tampered' };
  const port: ConditionalReentrySubmissionPort = {
    async prepare() { return { ...prepared, command: tamperedCommand }; },
    async commitReentryRecord() { throw new Error('unreachable: preparation must reject before commit'); },
    async readReentry() { return null; },
  };

  // Preparation must return the confirmed command unchanged.
  await rejectsWithMessage(
    () => commitReentry({ ownerId: 'task-owner', conditional: { port, command } }),
    /conditional preparation changed the confirmed command/,
  );
  assert.equal(closurePort.committed.length, 1);
});

test('reentry rejects a corrupt journal before admission or closure commit', async () => {
  const committedCheckpoint = checkpoint(1, null);
  const journal = new FakeJournal();
  const closurePort = new FakeClosurePort();
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId: 'task-owner',
    checkpoint: committedCheckpoint,
    previous: null,
    journal,
    closurePort,
  });
  const canonicalId = `checkpoint-closure:${checkpointCommitId(committedCheckpoint)}`;
  const { command, port, commits } = conditionalReentryFixture(committedCheckpoint, canonicalId);

  // The verified principal must own the confirmed command.
  await rejectsWithMessage(
    () => commitReentry({ ownerId: 'other-owner', conditional: { port, command } }),
    /reentry owner does not match the verified principal/,
  );
  // The legacy unbound mutation stays read-only.
  await rejectsWithMessage(
    () => commitReentry({
      ownerId: 'task-owner',
      closureId: 'reentry-legacy-unbound',
      checkpoint: committedCheckpoint,
      previousExecutionEpoch: committedCheckpoint.executionEpoch,
      newExecutionEpoch: committedCheckpoint.executionEpoch + 1,
      nextAction: { kind: 'continue', ref: 'after-legacy-unbound' },
      journal,
      closurePort,
      admissionPort: new FakeAdmissionPort(),
    }),
    /legacy unbound reentry is read-only/,
  );
  assert.equal(commits.length, 0);
  assert.equal(closurePort.committed.length, 1);
});
