import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractError, id } from '../../../packages/contracts/src/index.js';
import { FakeAgentDriver, type FakeExecutionEvidence } from '../../../packages/adapters/testing/src/index.js';

const task = id('task', 'task-a');
const outcomes = ['succeeded', 'waiting', 'blocked', 'failed', 'cancelled', 'stopped'] as const;

test('fake driver covers explicit result branches with typed evidence', async () => {
  for (const outcome of outcomes) {
    const driver = new FakeAgentDriver({ [`assignment-${outcome}`]: outcome });
    await driver.start({ runtimeId: `runtime-${outcome}`, taskId: task, executionEpoch: 1, assignmentId: `assignment-${outcome}` });
    const output = await driver.submit({ taskId: task, executionEpoch: 1, assignmentId: `assignment-${outcome}`, payload: { branch: outcome } });
    assert.equal(output.payload.outcome, outcome);
    const evidence = driver.replay().at(-1);
    if (!evidence) throw new Error('missing fake evidence');
    assert.equal(evidence.sessionRef.includes('fake-session-'), true);
    assert.equal(evidence.outcome, outcome);
    assert.ok(evidence.evidenceRefs.length >= 1);

    if (outcome === 'stopped') {
      const receipt = await driver.requestStop({ runtimeId: `runtime-${outcome}`, executionEpoch: 1, operationId: evidence.operationId });
      assert.equal(receipt.requested, true);
    }
    const closure = await driver.settle({ runtimeId: `runtime-${outcome}`, executionEpoch: 1 });
    assert.equal(closure.state, outcome);
  }
});

test('fake driver replay is deterministic across same inputs', async () => {
  const replay = async (): Promise<readonly FakeExecutionEvidence[]> => {
    const driver = new FakeAgentDriver({ assignment: 'blocked' });
    await driver.start({ runtimeId: 'runtime-replay', taskId: task, executionEpoch: 1, assignmentId: 'assignment' });
    await driver.submit({ taskId: task, executionEpoch: 1, assignmentId: 'assignment', payload: { attempt: 1 } });
    await driver.submit({ taskId: task, executionEpoch: 1, assignmentId: 'assignment', payload: { attempt: 1 } });
    return driver.replay();
  };
  assert.deepEqual(await replay(), await replay());
});

test('fake driver rejects stale, unbound, and evidence-less sessions', async () => {
  const driver = new FakeAgentDriver();
  await assert.rejects(driver.resume({ runtimeId: 'missing', taskId: task, executionEpoch: 1, checkpointId: id('checkpoint', 'cp-1') }), ContractError);
  await assert.rejects(driver.submit({ taskId: task, executionEpoch: 1, assignmentId: 'missing', payload: { attempt: 1 } }), ContractError);
  await driver.start({ runtimeId: 'runtime-empty', taskId: task, executionEpoch: 1, assignmentId: 'assignment-empty' });
  await assert.rejects(driver.settle({ runtimeId: 'runtime-empty', executionEpoch: 1 }), ContractError);
});
