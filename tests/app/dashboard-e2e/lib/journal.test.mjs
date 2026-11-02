import assert from 'node:assert/strict';
import test from 'node:test';

import { executionIdentityFromRecords } from './journal.mjs';

const TASK = 'task-journal-epoch';
const CYCLE = 'cycle-journal-epoch';
const ORGAN = 'organ-journal-epoch';

function started(overrides = {}) {
  return {
    kind: 'operation.started',
    taskId: TASK,
    operationId: 'scheduled-operation-1',
    cycleId: CYCLE,
    scope: { organId: ORGAN, taskId: TASK, cycleId: CYCLE },
    executionEpoch: 1,
    startedAt: '2026-10-30T09:00:00Z',
    ...overrides,
  };
}

function binding() {
  return {
    organId: ORGAN,
    executionTaskId: TASK,
    taskId: TASK,
    operationId: null,
    cycleId: CYCLE,
    executionEpoch: null,
  };
}

test('executionIdentityFromRecords keeps the latest executionEpoch start and never rejects for a null operationId binding', () => {
  const records = [
    started({ executionEpoch: 1, operationId: 'scheduled-operation-1', startedAt: '2026-10-30T09:00:00Z' }),
    started({ executionEpoch: 2, operationId: 'ui-operation-2', startedAt: '2026-10-30T10:00:00Z' }),
  ];

  const result = executionIdentityFromRecords(records, binding());

  assert.equal(result.ok, true, result.reason);
  assert.equal('reason' in result, false, 'an ok identity result must not carry a reason');
  assert.equal(result.identity.executionEpoch, 2);
  assert.equal(result.identity.operationId, 'ui-operation-2');
  assert.equal(result.identity.startedAt, '2026-10-30T10:00:00Z');
  assert.equal(result.identity.taskId, TASK);
  assert.equal(result.identity.cycleId, CYCLE);
});

test('the latest execution identity is deterministic regardless of record order', () => {
  const epoch1 = started({ executionEpoch: 1, operationId: 'scheduled-operation-1', startedAt: '2026-10-30T09:00:00Z' });
  const epoch2 = started({ executionEpoch: 2, operationId: 'ui-operation-2', startedAt: '2026-10-30T10:00:00Z' });

  const forward = executionIdentityFromRecords([epoch1, epoch2], binding());
  const reverse = executionIdentityFromRecords([epoch2, epoch1], binding());

  assert.equal(forward.ok, true, forward.reason);
  assert.equal(reverse.ok, true, reverse.reason);
  assert.equal(forward.identity.executionEpoch, 2);
  assert.equal(reverse.identity.executionEpoch, 2);
  assert.deepEqual(forward.identity, reverse.identity);
});

test('the same executionEpoch tie-breaks by the later startedAt', () => {
  const records = [
    started({ executionEpoch: 3, operationId: 'op-earlier', startedAt: '2026-10-30T09:00:00Z' }),
    started({ executionEpoch: 3, operationId: 'op-later', startedAt: '2026-10-30T09:30:00Z' }),
  ];

  const result = executionIdentityFromRecords(records, binding());

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.identity.startedAt, '2026-10-30T09:30:00Z');
  assert.equal(result.identity.operationId, 'op-later');
});

test('different operations tied at the latest execution position stay ambiguous without a bound operationId', () => {
  const records = [
    started({
      executionEpoch: 4,
      operationId: 'op-first',
      cycleId: null,
      startedAt: '2026-10-30T10:00:00Z',
    }),
    started({
      executionEpoch: 4,
      operationId: 'op-second',
      cycleId: null,
      startedAt: '2026-10-30T10:00:00Z',
    }),
  ];

  const result = executionIdentityFromRecords(records, { ...binding(), operationId: null, cycleId: null });

  assert.equal(result.ok, false);
  assert.match(result.reason, /ambiguous/);
});

test('a matching start with a null record operationId is still resolved without an injected operationId', () => {
  const records = [
    started({ executionEpoch: 1, operationId: null, startedAt: '2026-10-30T09:00:00Z' }),
    started({ executionEpoch: 2, operationId: null, startedAt: '2026-10-30T10:00:00Z' }),
  ];

  const result = executionIdentityFromRecords(records, binding());

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.identity.operationId, null);
  assert.equal(result.identity.executionEpoch, 2);
});

test('no matching operation.started record stays unresolved', () => {
  const records = [started({ taskId: 'other-task', scope: { organId: ORGAN, taskId: 'other-task', cycleId: CYCLE } })];

  const result = executionIdentityFromRecords(records, binding());

  assert.equal(result.ok, false);
  assert.match(result.reason, /no verified operation\.started record/);
});
