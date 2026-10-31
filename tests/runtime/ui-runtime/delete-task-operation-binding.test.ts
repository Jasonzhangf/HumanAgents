import assert from 'node:assert/strict';
import test from 'node:test';

import {
  id,
  type CycleId,
  type OperationId,
  type ScopeRef,
  type TaskId,
} from '../../../packages/contracts/src/index.js';
import {
  RuntimeTaskCoordinator,
  RuntimeTaskControlError,
  replayTaskJournalRecords,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
  type RuntimeTaskCoordinatorOptions,
  type RuntimeTaskJournalPort,
  type RuntimeTaskJournalRecord,
  type TaskJournalReplayState,
} from '../../../packages/runtime/src/ui-runtime/coordinator.js';

const organId = id('organ', 'delete-task-binding-organ');
const taskId = id('task', 'scheduled-task-delete-binding');
const operationId = id('operation', 'scheduled-operation-delete-binding');
const prompt = 'report the durable root';

class MemoryTaskJournal implements RuntimeTaskJournalPort {
  readonly records: RuntimeTaskJournalRecord[];

  constructor(seed: readonly RuntimeTaskJournalRecord[] = []) {
    this.records = [...structuredClone(seed)] as RuntimeTaskJournalRecord[];
  }

  append(record: RuntimeTaskJournalRecord): void {
    this.records.push(structuredClone(record));
  }

  replay(): readonly RuntimeTaskJournalRecord[] {
    return structuredClone(this.records);
  }
}

/**
 * A provider driver with no work of its own. It exists only so a prepared
 * execution can reach a real terminal, which is the state in which a task is
 * deletable while its operation record is still in custody.
 */
class IdleDriver implements RuntimeExecutionDriver {
  readonly kind = 'delete-task-binding.fake-driver';

  constructor(readonly input: RuntimeExecutionDriverInput) {}

  async capabilities() {
    return { driverKind: this.kind, capabilities: ['execute'], version: '1' };
  }

  async start(given: { readonly runtimeId: string; readonly executionEpoch: number }) {
    return { runtimeId: given.runtimeId, executionEpoch: given.executionEpoch };
  }

  async resume(given: { readonly runtimeId: string; readonly executionEpoch: number }) {
    return { runtimeId: given.runtimeId, executionEpoch: given.executionEpoch };
  }

  async submit(given: Parameters<RuntimeExecutionDriver['submit']>[0]) {
    return {
      taskId: given.taskId,
      executionEpoch: given.executionEpoch,
      assignmentId: given.assignmentId,
      payload: given.payload,
      outputRefs: [],
      evidenceRefs: [],
    };
  }

  async *observe(): AsyncIterable<never> {}

  async requestStop(given: Parameters<RuntimeExecutionDriver['requestStop']>[0]) {
    return { requested: true as const, operationId: given.operationId };
  }

  async settle() {
    return { state: 'succeeded' as const, evidenceRefs: [] };
  }

  async close() {
    return {
      bindingId: 'delete-task-binding',
      providerId: 'delete-task-binding-provider',
      protocol: 'responses' as const,
      state: 'closed' as const,
      evidenceRefs: [],
    };
  }
}

function checkpointStore(): ReturnType<NonNullable<RuntimeTaskCoordinatorOptions['checkpointStoreFor']>> {
  return {
    async verify() { return { valid: true as const }; },
    async readLatest() { return null; },
    // Stateless fake: nothing is persisted, so every committed read reports absence.
    async readCommitted() { return null; },
    async listCommitted() { return { checkpoints: [] }; },
    async readExecutionPosition() { return null; },
    async readCheckpointRecoveryBinding() { return null; },
    async append(given) { return { checkpointId: given.checkpoint.id, seq: given.checkpoint.seq }; },
    async commit(checkpoint) { return { checkpointId: checkpoint.id, committed: true as const }; },
  } as ReturnType<NonNullable<RuntimeTaskCoordinatorOptions['checkpointStoreFor']>>;
}

function coordinator(
  journal: MemoryTaskJournal,
  overrides: Partial<RuntimeTaskCoordinatorOptions> = {},
): RuntimeTaskCoordinator {
  return new RuntimeTaskCoordinator({
    organId,
    taskIdPrefix: 'delete-binding',
    admitExecution: async () => {},
    createDriver: (input) => new IdleDriver(input),
    checkpointStoreFor: () => checkpointStore(),
    attentionPort: {
      async publish(attention) { return { attentionId: attention.attentionId, delivered: true }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true }; },
    },
    journal,
    ...overrides,
  });
}

async function waitForTerminal(runtime: RuntimeTaskCoordinator, id: TaskId): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = runtime.taskSnapshot(id).state;
    if (state === 'succeeded' || state === 'failed' || state === 'stopped') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`runtime did not finish; state=${runtime.taskSnapshot(id).state}`);
}

/**
 * The exact production sequence for `scheduled-task-b258bd97ecc762223c7a` from
 * the UI runtime journal: one execution is prepared and started, stops, and the
 * task is then deleted and rebuilt under the same taskId 0.216 s later.
 */
function productionSequence(): RuntimeTaskJournalRecord[] {
  const scope: ScopeRef = {
    organId,
    taskId,
    cycleId: id('cycle', 'ui-cycle-delete-binding'),
    operationId,
  };
  return [
    {
      kind: 'task.created',
      taskId,
      title: '计划执行 subscription:requirement:draft-141:2::1::1',
      directive: prompt,
      directiveRevision: 1,
      createdAt: '2026-10-24T01:29:47.348Z',
      taskCounter: 1,
    },
    {
      kind: 'operation.prepared',
      allocation: {
        runtimeId: 'runtime-delete-binding',
        taskId,
        operationId,
        executionEpoch: 1,
        assignmentId: `assignment-${operationId.value}`,
        scope,
        inputRefs: [`task://${taskId.value}/input/1`],
        ownerId: 'humanagent.runtime',
        directiveRevision: 1,
        inputRevision: 1,
        orchestrated: false,
      },
      input: prompt,
      operationCounter: 1,
      cycleCounter: 1,
    },
    {
      kind: 'operation.started',
      operationId,
      taskId,
      cycleId: scope.cycleId as CycleId,
      scope,
      executionEpoch: 1,
      operationCounter: 1,
      cycleCounter: 1,
      startedAt: '2026-10-24T01:29:47.400Z',
      input: prompt,
    },
    {
      kind: 'operation.event',
      operationId,
      event: {
        eventId: 'checkpoint.committed/delete-binding',
        seq: 1,
        occurredAt: '2026-10-26T14:40:41.000Z',
        taskId,
        operationId: operationId.value,
        executionEpoch: 1,
        kind: 'checkpoint.committed',
        state: 'stopped',
        summary: 'stopped',
        evidenceRefs: [],
      },
    },
    {
      kind: 'operation.event',
      operationId,
      event: {
        eventId: 'execution.terminal/delete-binding',
        seq: 2,
        occurredAt: '2026-10-26T14:40:41.500Z',
        taskId,
        operationId: operationId.value,
        executionEpoch: 1,
        kind: 'execution.terminal',
        state: 'stopped',
        terminalPhase: 'final',
        summary: 'stopped',
        evidenceRefs: [],
      },
    },
    { kind: 'task.deleted', taskId, deletedAt: '2026-10-26T14:40:44.691Z' },
    {
      kind: 'task.created',
      taskId,
      title: '计划执行 subscription:requirement:draft-141:2::1::1',
      directive: prompt,
      directiveRevision: 1,
      createdAt: '2026-10-26T14:40:44.907Z',
      taskCounter: 2,
    },
  ];
}

test('deleting a terminal task retires its operation binding', async () => {
  const journal = new MemoryTaskJournal();
  const runtime = coordinator(journal);
  runtime.createTask({ taskId, title: 'delete binding', directive: prompt });
  const started = runtime.startExecution(taskId, { prompt, operationId });
  assert.equal(started.operationId.value, operationId.value);
  await waitForTerminal(runtime, taskId);
  // A terminal task is deletable, and its operation record is still in custody:
  // the terminal path clears the scope, never the operation.
  assert.equal(runtime.taskSnapshot(taskId).state, 'succeeded');
  assert.equal(runtime.operationTask(operationId).value, taskId.value);

  const deleted = runtime.deleteTask(taskId);
  assert.equal(deleted.deleted, true);

  // The deletion owns the custody end for every binding of that task. A residual
  // operation is observable through the public operation lookup, and it is what
  // lets a rebuild silently reuse a dead execution.
  assert.throws(
    () => runtime.operationTask(operationId),
    (error: unknown) => error instanceof RuntimeTaskControlError && error.code === 'operation.not.found',
    'a deleted task must not leave its operation resolvable',
  );
});

test('replay of the deleted-then-rebuilt sequence does not revive the old operation', () => {
  const records = productionSequence();
  const state: TaskJournalReplayState = {
    taskCounter: 0,
    operationCounter: 0,
    cycleCounter: 0,
    tasks: new Map(),
    operations: new Map(),
    scopes: new Map(),
    deletedTaskIds: new Set(),
  };
  replayTaskJournalRecords(state, records);

  // The rebuild replays, so the task exists again and is startable.
  const rebuilt = state.tasks.get(taskId.value);
  assert.notEqual(rebuilt, undefined, 'the rebuilt task must survive replay');
  assert.equal(rebuilt?.operationId, undefined, 'a rebuilt task starts without an execution');
  assert.equal(rebuilt?.release, undefined, 'a rebuilt task must not inherit a prepared release');
  // The deleted execution must not.
  assert.equal(state.operations.has(operationId.value), false, 'the deleted execution operation must not be replayed');
  assert.equal(state.scopes.has(operationId.value), false, 'the deleted execution scope must not be replayed');

  // The same guarantee through the public coordinator surface a restart uses.
  const restarted = coordinator(new MemoryTaskJournal(records));
  const snapshot = restarted.taskSnapshot(taskId);
  assert.equal(snapshot.state, 'created');
  assert.equal(snapshot.operationId, undefined);
  assert.throws(
    () => restarted.operationTask(operationId),
    (error: unknown) => error instanceof RuntimeTaskControlError && error.code === 'operation.not.found',
    'restart must not resolve the operation of a deleted task',
  );
});

test('an undeleted task still reuses its original allocation on the same operationId retry', () => {
  const journal = new MemoryTaskJournal();
  const runtime = coordinator(journal);
  runtime.createTask({ taskId, title: 'retry', directive: prompt });
  const first = runtime.prepareExecution(taskId, { prompt, operationId });
  assert.equal(first.operationId.value, operationId.value);
  assert.equal(
    journal.records.filter((record) => record.kind === 'operation.started').length,
    1,
    'the first preparation starts exactly one operation',
  );

  const retry = runtime.prepareExecution(taskId, { prompt, operationId });
  assert.strictEqual(retry, first, 'an exact retry returns the persisted allocation');
  assert.equal(retry.executionEpoch, first.executionEpoch);
  assert.equal(
    journal.records.filter((record) => record.kind === 'operation.started').length,
    1,
    'an exact retry never mints a second operation',
  );
  assert.equal(runtime.operationTask(operationId).value, taskId.value);
});
