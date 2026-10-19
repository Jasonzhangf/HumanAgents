import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type Checkpoint } from '../../../packages/contracts/src/index.js';
import type { JournalRecord } from '../../../packages/adapters/jsonl/src/index.js';
import { readRuntimeTaskCurrentStateFromRecords } from '../../../packages/app/src/runtime-current-state-journal.js';
import type { RuntimeTaskCurrentState } from '../../../packages/runtime/src/ui-runtime/current-state.js';
import { checkpointCommitId } from '../../../packages/runtime/src/checkpoints/coordinator.js';
import { RuntimeTaskCoordinator, projectDurableTaskInventory, type RuntimeTaskJournalRecord,
  type DurableTaskCurrentStateReadPort, type RuntimeInspectionStopSettlementPort,
  type RuntimeTaskHydrateReadSource } from '../../../packages/runtime/src/ui-runtime/coordinator.js';

// A cold-read error resurrection has occurred. This small public consumer binds
// only read ports; it tests retained errors and false-live status without an
// execution fixture, Provider, or durable writes.
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
  // This is a legacy checkpoint fixture, with no native receipt relationship.
  const commitRef = { commitId: checkpointCommitId(checkpoint), journalSeq: 2, recordDigest: 'owner-receipt' };
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
    if (variant === 'aligned' || variant === 'retained-error') {
      // Failure has occurred on cold hydration: an older blocked checkpoint
      // wins over a newer succeeded owner record. These two read-only cases
      // catch that regression and enforce the existing strict error policy.
      const blockedCheckpoint: Checkpoint = { ...checkpoint, outcome: 'blocked',
        evidenceRefs: [checkpoint.recoveryStateRef], next: { kind: 'recover', ref: 'runtime' } };
      const checkpointCommitRef = { ...commitRef, journalSeq: 698 };
      const newerSourceRecord = { ...sourceRecord, seq: 699 } as JournalRecord;
      const failWrite = () => { throw new Error('cold hydration must not execute or write'); };
      const store = {
        readLatest: async () => ({ checkpoint: blockedCheckpoint, previous: null }),
        readCommitted: async () => ({ checkpoint: blockedCheckpoint, previous: null, commitRef: checkpointCommitRef }),
        verify: async () => ({ valid: true as const }),
        append: failWrite,
        commit: failWrite,
        listCommitted: failWrite,
        readExecutionPosition: async () => null,
        readCheckpointRecoveryBinding: failWrite,
      };
      const currentStatePort = {
        read: async (taskScope: Parameters<typeof port.read>[0]) =>
          readRuntimeTaskCurrentStateFromRecords([newerSourceRecord], taskScope),
        commit: failWrite,
      };
      const inventory = await projectDurableTaskInventory({ records,
        checkpointFor: () => store, currentStateFor: () => currentStatePort });
      assert.equal(inventory.entries[0].snapshot.state, 'succeeded');
      const source: RuntimeTaskHydrateReadSource = {
        checkpoint: {
          verify: store.verify,
          readLatest: store.readLatest,
          readCommitted: store.readCommitted,
          readExecutionPosition: store.readExecutionPosition,
        },
        currentState: { read: currentStatePort.read },
      };
      let legacyReads = 0;
      let resolverReads = 0;
      const coordinator = new RuntimeTaskCoordinator({
        organId: scope.organId, createDriver: failWrite,
        checkpointStoreFor: () => {
          assert.ok(retainedError, 'selected pair must not access the per-cycle reader');
          legacyReads += 1;
          return store;
        },
        attentionPort: { publish: failWrite, resolve: failWrite },
        journal: { replay: () => records, append: failWrite },
        currentStatePort: retainedError ? currentStatePort : { read: failWrite, commit: failWrite },
        hydrateReadFor: async (requestedScope) => {
          assert.deepEqual(requestedScope, scope);
          resolverReads += 1;
          return retainedError ? undefined : source;
        },
      });
      await coordinator.hydrate();
      assert.equal(resolverReads, 1);
      assert.equal(legacyReads, retainedError ? 1 : 0);
      const snapshot = coordinator.taskSnapshots()[0];
      assert.equal(snapshot.state, 'succeeded');
      assert.equal(snapshot.error?.code, retainedError ? error.code : undefined);
      assert.deepEqual(snapshot.checkpoint && {
        id: snapshot.checkpoint.checkpointId, seq: snapshot.checkpoint.seq,
        outcome: snapshot.checkpoint.outcome,
      }, { id: checkpoint.id.value, seq: 1, outcome: 'blocked' });
      assert.deepEqual(snapshot.allowedActions, ['start']);
      assert.equal(snapshot.nextStep, '查看任务详情');
      if (!retainedError) {
        const hookError = { ...error, code: 'execution.context-commit-hook.blocked', nextAction: 'repair context hook' };
        const hookRecords = records.map((record) => record.kind === 'operation.event'
          ? { ...record, error: hookError } : record);
        const guarded = new RuntimeTaskCoordinator({
          organId: scope.organId, createDriver: failWrite,
          checkpointStoreFor: () => store,
          attentionPort: { publish: failWrite, resolve: failWrite },
          journal: { replay: () => hookRecords, append: failWrite }, currentStatePort,
        });
        await guarded.hydrate();
        const guardedSnapshot = guarded.taskSnapshots()[0];
        assert.equal(guardedSnapshot.state, 'blocked');
        assert.equal(guardedSnapshot.error?.code, hookError.code);
        assert.equal(guardedSnapshot.nextStep, hookError.nextAction);
        assert.deepEqual(guardedSnapshot.allowedActions, []);
      }
    }
  }
  const unreadable = await projectDurableTaskInventory({ records,
    checkpointFor: () => ({ readLatest: async () => { throw new Error('unreadable'); } }) });
  assert.equal(unreadable.failures[0].code, 'checkpoint.unreadable');
  assert.equal(unreadable.entries[0].durableState, 'recovery-required');
  assert.equal(JSON.stringify(records), original);
});

test('named inspection inventory only reads durable stop completion', async () => {
  const taskId = id('task', 'inspection-inventory');
  const cycleId = id('cycle', 'inspection-inventory');
  const operationId = id('operation', 'inspection-inventory');
  const scope = { organId: id('organ', 'inspection-inventory'), taskId, cycleId, operationId };
  const records: RuntimeTaskJournalRecord[] = [
    { kind: 'task.created', taskId, title: 'inspection inventory', directive: '', directiveRevision: 1,
      createdAt: '2026-10-17T00:00:00Z', taskCounter: 1 },
    { kind: 'operation.started', taskId, cycleId, operationId, scope, executionEpoch: 1,
      operationCounter: 1, cycleCounter: 1, startedAt: '2026-10-17T00:00:00Z', input: 'inspect' },
  ];
  const checkpoint: Checkpoint = {
    id: id('checkpoint', 'inspection-inventory'), scope, cycleId, seq: 1, previousCheckpointId: null,
    directiveRevision: 1, executionEpoch: 1, outcome: 'stopped', summary: 'stopped',
    recoveryStateRef: { evidenceId: id('evidence', 'inspection-recovery'), kind: 'external', source: 'runtime',
      locator: 'recovery', scope }, evidenceRefs: [], next: { kind: 'stop' },
  };
  const commitRef = { commitId: 'inspection-checkpoint', journalSeq: 2, recordDigest: 'inspection-receipt' };
  let settleCalls = 0;
  const inspection: RuntimeInspectionStopSettlementPort = {
    settleStop: async () => { settleCalls += 1; return { state: 'complete', settlementCommitRefs: [] }; },
    readStopCompletion: async ({ checkpoint: exact }) => {
      assert.equal(exact.commitRef, commitRef);
      assert.equal(exact.checkpoint, checkpoint);
      return { state: 'recovery-required', settlementCommitRefs: [] };
    },
  };
  const inventory = await projectDurableTaskInventory({
    records,
    checkpointFor: () => ({
      readLatest: async () => ({ checkpoint, previous: null }),
      readCommitted: async () => ({ checkpoint, previous: null, commitRef }),
    }),
    inspectionStopFor: () => inspection,
  });
  assert.equal(settleCalls, 0, 'inventory must not commit I2');
  assert.equal(inventory.entries[0].durableState, 'recovery-required');
  assert.equal(inventory.entries[0].snapshot.state, 'blocked');
  assert.equal(inventory.entries[0].snapshot.error?.code, 'inspection.stop-settlement.pending');
  const missingExact = await projectDurableTaskInventory({ records,
    checkpointFor: () => ({ readLatest: async () => ({ checkpoint, previous: null }) }),
    inspectionStopFor: () => inspection,
  });
  assert.equal(missingExact.entries[0].durableState, 'recovery-required');
  assert.equal(settleCalls, 0);

  // I2 recovery must precede the context-hook early return, without clearing
  // that independent recovery duty. Reuses the same inventory records/reader.
  const hookError = { code: 'execution.context-commit-hook.blocked', ownerId: 'test.context',
    message: 'context publication pending', retryable: true, nextAction: 'repair context hook' };
  const coldRecords: RuntimeTaskJournalRecord[] = [...records, { kind: 'operation.event', operationId,
    error: hookError, event: { eventId: 'context-error', seq: 1, occurredAt: '2026-10-17T00:00:01Z',
      taskId, operationId: operationId.value, executionEpoch: 1, kind: 'provider.error', state: 'blocked',
      summary: hookError.message, evidenceRefs: [] } }];
  const coldCheckpoint: Checkpoint = { ...checkpoint, evidenceRefs: [checkpoint.recoveryStateRef],
    next: { kind: 'stop', ref: 'operator-stop' } };
  const exact = { checkpoint: coldCheckpoint, previous: null,
    commitRef: { ...commitRef, commitId: checkpointCommitId(coldCheckpoint) } };
  const noEffects = () => { throw new Error('cold supplement must not execute, stop or publish context'); };
  let failSupplement = true;
  const cold = new RuntimeTaskCoordinator({
    organId: scope.organId, createDriver: noEffects,
    journal: { replay: () => coldRecords, append: noEffects },
    attentionPort: { publish: noEffects, resolve: noEffects },
    checkpointStoreFor: () => ({
      verify: async () => ({ valid: true as const }),
      readLatest: async () => ({ checkpoint: coldCheckpoint, previous: null }), readCommitted: async () => exact,
      readExecutionPosition: async () => null, readCheckpointRecoveryBinding: noEffects,
      listCommitted: noEffects, append: noEffects, commit: noEffects,
    }),
    inspectionStop: {
      async settleStop({ checkpoint: retained }) {
        settleCalls += 1;
        assert.equal(retained, exact);
        if (failSupplement) throw new Error('retained inspection supplement failed');
        return { state: 'complete', settlementCommitRefs: [] };
      },
      readStopCompletion: async () => ({ state: 'complete', settlementCommitRefs: [] }),
    },
  });
  await cold.hydrate();
  let snapshot = cold.taskSnapshot(taskId);
  assert.equal(settleCalls, 1);
  assert.equal(snapshot.checkpoint?.outcome, 'stopped');
  assert.equal(snapshot.error?.code, hookError.code);
  assert.equal(snapshot.error?.cleanupError?.code, 'inspection.stop-settlement.failed');
  assert.equal(snapshot.error?.cleanupError?.message, 'retained inspection supplement failed');
  assert.equal(snapshot.currentState, 'checkpoint 已提交，等待恢复');
  assert.deepEqual(snapshot.allowedActions, []);
  failSupplement = false;
  await cold.hydrate();
  snapshot = cold.taskSnapshot(taskId);
  assert.equal(settleCalls, 2);
  assert.equal(snapshot.state, 'blocked');
  assert.equal(snapshot.error?.code, hookError.code);
  assert.equal(snapshot.error?.cleanupError, undefined, 'only resolved I2 error is cleared');
  assert.equal(snapshot.nextStep, hookError.nextAction);
  assert.deepEqual(snapshot.allowedActions, []);
});

// Known source incident: lifecycle labels alone produced a human-decision and
// stop claim. Impact: false state and actions in the public inventory. Cost: one
// read-only fixture reused for the waiting and blocked states.
test('waiting and blocked inventory keep a concrete action without inventing a decision', async () => {
  const taskId = id('task', 'inventory-pending-copy');
  const cycleId = id('cycle', 'inventory-pending-copy');
  const operationId = id('operation', 'inventory-pending-copy');
  const scope = { organId: id('organ', 'inventory-pending-copy'), taskId, cycleId, operationId };
  const records: RuntimeTaskJournalRecord[] = [
    { kind: 'task.created', taskId, title: 'pending copy', directive: '', directiveRevision: 1,
      createdAt: '2026-10-17T00:00:00Z', taskCounter: 1 },
    { kind: 'operation.started', taskId, cycleId, operationId, scope, executionEpoch: 1,
      operationCounter: 1, cycleCounter: 1, startedAt: '2026-10-17T00:00:00Z', input: 'read' },
  ];
  const checkpoint: Checkpoint = {
    id: id('checkpoint', 'inventory-pending-copy'), scope, cycleId, seq: 1, previousCheckpointId: null,
    directiveRevision: 1, executionEpoch: 1, outcome: 'blocked', summary: 'needs recovery',
    recoveryStateRef: { evidenceId: id('evidence', 'recovery'), kind: 'external', source: 'runtime',
      locator: 'recovery', scope }, evidenceRefs: [], next: { kind: 'recover', ref: 'runtime' },
  };
  const commitRef = { commitId: 'pending-checkpoint', journalSeq: 2, recordDigest: 'pending-receipt' };
  const checkpointFor = () => ({
    readLatest: async () => ({ checkpoint, previous: null }),
    readCommitted: async () => ({ checkpoint, previous: null, commitRef }),
  });
  for (const state of ['waiting', 'blocked'] as const) {
    const value: RuntimeTaskCurrentState = {
      task: { id: taskId, organId: scope.organId, title: 'pending copy', directive: '',
        directiveRevision: 1, state, memoryScope: 'task' },
      processing: {
        entryPhase: 'aligned', nextAction: { kind: 'recover', ref: 'runtime' }, hardBlockers: [],
        recoveryResponsibilityRef: 'runtime', laterErrorRefs: [], stages: [],
      },
      retainedDuties: [], sourceCommitRefs: [commitRef],
    };
    const sourceRecord = {
      version: 1, previousRecordDigest: null, kind: 'event', seq: 3,
      commitId: `pending-${state}`, recordDigest: 'pending-receipt', scope,
      payload: { type: 'runtime-task-current-state', schemaVersion: 1, transitionId: `pending-${state}`, state: value },
    } as JournalRecord;
    const port: DurableTaskCurrentStateReadPort = {
      read: async (taskScope) => readRuntimeTaskCurrentStateFromRecords([sourceRecord], taskScope),
    };
    const result = await projectDurableTaskInventory({
      records, checkpointFor, currentStateFor: () => port,
    });
    const snapshot = result.entries[0].snapshot;
    assert.equal(snapshot.state, state);
    assert.equal(snapshot.currentState, state === 'waiting' ? '等待中' : '受阻');
    assert.equal(snapshot.nextStep, 'recover:runtime');
    assert.deepEqual(snapshot.allowedActions, []);
  }
});
