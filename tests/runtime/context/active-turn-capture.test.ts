import assert from 'node:assert/strict';
import test from 'node:test';
import { ActiveTurnProducerBarrier } from '../../../packages/runtime/src/context/active-turn-capture.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('capture waits for admitted raw and child adoption writes; late dispatch never starts', async () => {
  const barrier = new ActiveTurnProducerBarrier();
  const rawWrite = deferred();
  const childAdoption = deferred();
  const accepted: string[] = [];
  const raw = barrier.run(async () => {
    await rawWrite.promise;
    accepted.push('raw');
  });
  const child = barrier.run(async () => {
    await childAdoption.promise;
    accepted.push('adopted-refinement');
  });
  let captured: readonly string[] | undefined;
  const drain = barrier.closeAndDrain();
  const capture = drain.then(() => { captured = [...accepted]; });
  let lateStarted = false;
  await assert.rejects(barrier.run(() => { lateStarted = true; }));
  assert.equal(lateStarted, false);
  assert.equal(captured, undefined);
  rawWrite.resolve();
  await raw;
  assert.equal(captured, undefined, 'Provider raw completion cannot stand in for child adoption');
  childAdoption.resolve();
  await child;
  await capture;
  assert.deepEqual(captured, ['raw', 'adopted-refinement']);
  assert.equal(barrier.closeAndDrain(), drain, 'the same closed cut shares one drain');
});

test('producer rejection keeps capture failed but waits for remaining durable work', async () => {
  const barrier = new ActiveTurnProducerBarrier();
  const remaining = deferred();
  const original = new Error('durable acceptance failed');
  const failed = barrier.run(() => { throw original; });
  await assert.rejects(failed);
  let written = false;
  const successful = barrier.run(async () => {
    await remaining.promise;
    written = true;
  });
  let outcome = 'pending';
  const drain = barrier.closeAndDrain().then(
    () => { outcome = 'success'; },
    (error: unknown) => { assert.equal(error, original); outcome = 'failure'; },
  );
  await Promise.resolve();
  assert.equal(outcome, 'pending');
  remaining.resolve();
  await successful;
  await drain;
  assert.equal(written, true);
  assert.equal(outcome, 'failure');
});
