import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type Checkpoint } from '../../../packages/contracts/src/index.js';
import type { JournalRecord } from '../../../packages/adapters/jsonl/src/index.js';
import { readRuntimeTaskCurrentStateFromRecords } from '../../../packages/app/src/runtime-current-state-journal.js';
import type { RuntimeTaskCurrentState } from '../../../packages/runtime/src/ui-runtime/current-state.js';
import { projectDurableTaskInventory, type RuntimeTaskJournalRecord,
  type DurableTaskCurrentStateReadPort } from '../../../packages/runtime/src/ui-runtime/coordinator.js';

// A cold-read error resurrection has occurred. This small public consumer binds
// only read ports; it tests retained errors and false-live status without a
// coordinator, execution fixture, Provider, or durable writes.
test('durable inventory never claims live and only clears fully aligned errors', async () => {
  const taskId = id('task', 'inventory');
  const cycleId = id('cycle', 'inventory');
  const operationId = id('operation', 'inventory');
  const scope = { organId: id('organ', 'inventory'), taskId, cycleId, operationId };
  const error = { code: 'old.failure', ownerId: 'runtime', message: 'retained', retryable: false, nextAction: 'recover' };
  const records: RuntimeTaskJournalRecord[] = [
    { kind: 'task.created', taskId, title: 'inventory', directive: '', directiveRevision: 1,
      createdAt: '2026-10-17T00:00:00Z', taskCounter: 1 },
    { kind: 'operation.started', taskId, cycleId, operationId, scope, executionEpoch: 1,
      operationCounter: 1, cycleCounter: 1, startedAt: '2026-10-17T00:00:00Z', input: 'read' },
    { kind: 'operation.event', operationId, error, event: {
      eventId: 'started', seq: 1, occurredAt: '2026-10-17T00:00:00Z', taskId,
      operationId: operationId.value, executionEpoch: 1, kind: 'execution.started',
      state: 'running', summary: 'persisted running', evidenceRefs: [],
    } },
  ];
  const original = JSON.stringify(records);
  const checkpoint: Checkpoint = {
    id: id('checkpoint', 'inventory'), scope, cycleId, seq: 1, previousCheckpointId: null,
    directiveRevision: 1, executionEpoch: 1, outcome: 'succeeded', summary: 'closed',
    recoveryStateRef: { evidenceId: id('evidence', 'recovery'), kind: 'external', source: 'runtime',
      locator: 'recovery', scope }, evidenceRefs: [], next: { kind: 'continue' },
  };
  const commitRef = { commitId: 'checkpoint', journalSeq: 2, recordDigest: 'owner-receipt' };
  const checkpointFor = () => ({
    readLatest: async () => ({ checkpoint, previous: null }),
    readCommitted: async () => ({ checkpoint, previous: null, commitRef }),
  });
  const missing = await projectDurableTaskInventory({ records,
    checkpointFor: () => ({ readLatest: async () => null }) });
  assert.equal(missing.entries[0].snapshot.state, 'unknown');
  assert.equal(missing.entries[0].durableState, 'recovery-required');
  assert.deepEqual(missing.entries[0].snapshot.allowedActions, []);
  const checkpointOnly = await projectDurableTaskInventory({ records, checkpointFor });
  assert.equal(checkpointOnly.entries[0].snapshot.error?.code, error.code);
  for (const variant of ['aligned', 'retained-error', 'other-operation', 'older-state'] as const) {
    const retainedError = variant === 'retained-error';
    const sourceScope = variant === 'other-operation'
      ? { ...scope, operationId: id('operation', 'other') } : scope;
    const value: RuntimeTaskCurrentState = {
        task: { id: taskId, organId: scope.organId, title: 'inventory', directive: '',
          directiveRevision: 1, state: 'succeeded', memoryScope: 'task' },
        processing: { entryPhase: 'aligned', nextAction: { kind: 'continue' }, hardBlockers: [],
          recoveryResponsibilityRef: 'runtime', firstErrorRef: retainedError ? 'retained' : undefined,
          laterErrorRefs: [], stages: [{ stageId: 'alignment', state: 'succeeded', value: undefined, evidenceRefs: [] }] },
        retainedDuties: [], sourceCommitRefs: [commitRef],
      };
    const sourceRecord = {
      version: 1, previousRecordDigest: null,
      kind: 'event', seq: variant === 'older-state' ? 1 : 3,
      commitId: 'aligned', recordDigest: 'owner-receipt', scope: sourceScope,
      payload: { type: 'runtime-task-current-state', schemaVersion: 1, transitionId: 'aligned', state: value },
    } as JournalRecord;
    // Use the App decoder's actual ABI, with a task-only query that cannot
    // supply the execution scope stored on the source Journal record.
    const read = readRuntimeTaskCurrentStateFromRecords([sourceRecord], { organId: scope.organId, taskId });
    assert.equal(read.state, 'known');
    if (read.state === 'known') assert.equal(read.scope, sourceRecord.scope);
    const port: DurableTaskCurrentStateReadPort = {
      read: async (taskScope) => readRuntimeTaskCurrentStateFromRecords([sourceRecord], taskScope),
    };
    const result = await projectDurableTaskInventory({ records, checkpointFor, currentStateFor: () => port });
    assert.deepEqual(result.failures, []);
    assert.equal(result.entries[0].snapshot.state, 'succeeded');
    assert.equal(result.entries[0].snapshot.error?.code, variant === 'aligned' ? undefined : error.code);
  }
  const unreadable = await projectDurableTaskInventory({ records,
    checkpointFor: () => ({ readLatest: async () => { throw new Error('unreadable'); } }) });
  assert.equal(unreadable.failures[0].code, 'checkpoint.unreadable');
  assert.equal(unreadable.entries[0].durableState, 'recovery-required');
  assert.equal(JSON.stringify(records), original);
});
