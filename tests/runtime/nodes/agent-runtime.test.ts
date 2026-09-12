import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractError, id, type AgentEvent } from '../../../packages/contracts/src/index.js';
import { FakeAgentDriver } from '../../../packages/adapters/testing/src/index.js';
import { AgentRuntime, type AgentRuntimeObservation } from '../../../packages/runtime/src/nodes/agent-runtime.js';
import { RuntimeError } from '../../../packages/runtime/src/nodes/errors.js';

const task = id('task', 'task-agent');

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

class LateEventDriver extends FakeAgentDriver {
  override async *observe(input: { readonly runtimeId: string }): AsyncIterable<AgentEvent> {
    yield { taskId: task, executionEpoch: 2, kind: 'stale.operation', evidenceRefs: [] };
    yield* super.observe(input);
  }
}

test('agent runtime binds start, submit, observe, and settle to assignment epoch', async () => {
  const driver = new FakeAgentDriver();
  const runtime = new AgentRuntime(driver, {
    runtimeId: 'runtime-a',
    taskId: task,
    assignmentId: 'assignment-a',
    executionEpoch: 1,
    ownerRef: 'agent-runtime-owner',
    recoveryRef: 'runtime-recovery',
  });

  const handle = await runtime.start();
  assert.equal(handle.runtimeId, 'runtime-a');
  const output = await runtime.submit({ branch: 'ok' });
  assert.equal(output.assignmentId, 'assignment-a');
  const closure = await runtime.settle();
  assert.equal(closure.state, 'succeeded');
  assert.equal(closure.ownerRef, 'agent-runtime-owner');
  assert.equal(runtime.snapshot().state, 'succeeded');
});

test('ordinary settlement cannot finalize a stopped runtime without stop control', async () => {
  const runtime = new AgentRuntime(new FakeAgentDriver({ 'assignment-ordinary-stop': 'stopped' }), {
    runtimeId: 'runtime-ordinary-stop',
    taskId: task,
    assignmentId: 'assignment-ordinary-stop',
    executionEpoch: 1,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();
  await runtime.submit({ branch: 'ordinary-stop' });

  await assert.rejects(() => runtime.settle(), /use stop control/);
  assert.equal(runtime.snapshot().state, 'running');
});

test('ordinary settle rejection restores a recoverable runtime and preserves its cause', async () => {
  const cause = new Error('settle transport rejected');
  const driver = new FakeAgentDriver();
  const settle = driver.settle.bind(driver);
  let reject = true;
  driver.settle = async (input) => {
    if (reject) throw cause;
    return settle(input);
  };
  const runtime = new AgentRuntime(driver, {
    runtimeId: 'runtime-settle-rejection',
    taskId: task,
    assignmentId: 'assignment-settle-rejection',
    executionEpoch: 1,
    ownerRef: 'agent-runtime-owner',
    recoveryRef: 'runtime-settle-recovery',
  });
  await runtime.start();
  await runtime.submit({ branch: 'settle-rejection' });

  await assert.rejects(
    runtime.settle(),
    (error) => error instanceof RuntimeError
      && error.cause === cause
      && error.failureRef === 'runtime-settle-recovery',
  );
  assert.equal(runtime.snapshot().state, 'running');

  reject = false;
  const closure = await runtime.settle();
  assert.equal(closure.state, 'succeeded');
});

test('agent runtime rejects control data in business payload', async () => {
  const runtime = new AgentRuntime(new FakeAgentDriver(), {
    runtimeId: 'runtime-payload',
    taskId: task,
    assignmentId: 'assignment-payload',
    executionEpoch: 1,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();
  await assert.rejects(runtime.submit({ steer: true }), ContractError);
});

test('agent runtime serializes start initialization and rejects a concurrent start', async () => {
  const driver = new FakeAgentDriver();
  const gate = deferred<void>();
  const start = driver.start.bind(driver);
  driver.start = async (input) => {
    await gate.promise;
    return start(input);
  };
  const runtime = new AgentRuntime(driver, {
    runtimeId: 'runtime-start-race',
    taskId: task,
    assignmentId: 'assignment-start-race',
    executionEpoch: 1,
    ownerRef: 'agent-runtime-owner',
  });
  const first = runtime.start();
  await assert.rejects(runtime.start(), RuntimeError);
  gate.resolve();
  await first;
  assert.equal(runtime.snapshot().state, 'running');
});

test('stop claim fences a business submit already in flight', async () => {
  const driver = new FakeAgentDriver();
  const submitStarted = deferred<void>();
  const releaseSubmit = deferred<void>();
  const submit = driver.submit.bind(driver);
  driver.submit = async (input) => {
    submitStarted.resolve();
    await releaseSubmit.promise;
    return submit(input);
  };
  const runtime = new AgentRuntime(driver, {
    runtimeId: 'runtime-submit-stop-race',
    taskId: task,
    assignmentId: 'assignment-submit-stop-race',
    executionEpoch: 1,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();

  const pendingSubmit = runtime.submit({ branch: 'stop-race' });
  await submitStarted.promise;
  runtime.beginStop(
    'runtime-submit-stop-race',
    1,
    id('operation', 'operation-submit-stop-race'),
    'agent-runtime-owner',
    { organId: id('organ', 'organ-agent-runtime'), taskId: task, cycleId: id('cycle', 'cycle-agent-runtime') },
  );
  releaseSubmit.resolve();

  await assert.rejects(pendingSubmit, /active stop control/);
  assert.equal(runtime.snapshot().state, 'running');
});

test('late epoch events do not change current runtime state', async () => {
  const runtime = new AgentRuntime(new LateEventDriver(), {
    runtimeId: 'runtime-late',
    taskId: task,
    assignmentId: 'assignment-late',
    executionEpoch: 1,
    ownerRef: 'agent-runtime-owner',
    recoveryRef: 'runtime-recovery',
  });
  await runtime.start();
  await runtime.submit({ branch: 'ok' });

  const observations: AgentRuntimeObservation[] = [];
  for await (const observation of runtime.observe()) observations.push(observation);

  assert.equal(observations[0].accepted, false);
  if (observations[0].accepted) throw new Error('expected late event rejection');
  assert.equal(observations[0].rejection.reason, 'epoch-mismatch');
  assert.equal(observations[1].accepted, true);
  assert.equal(runtime.snapshot().state, 'running');
  assert.equal(runtime.staleEvents().length, 1);
});

test('waiting settle requires an explicit condition owner path', async () => {
  const driver = new FakeAgentDriver({ 'assignment-waiting': 'waiting' });
  const runtime = new AgentRuntime(driver, {
    runtimeId: 'runtime-waiting',
    taskId: task,
    assignmentId: 'assignment-waiting',
    executionEpoch: 1,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();
  await runtime.submit({ branch: 'waiting' });
  await assert.rejects(runtime.settle(), RuntimeError);
  assert.equal(runtime.snapshot().state, 'settling');
});
