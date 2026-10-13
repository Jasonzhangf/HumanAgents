import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type ActiveTurnBinding, type RawAsset, type RawFactEnvelope } from '../../../packages/contracts/src/index.js';
import { ActiveTurnContext } from '../../../packages/runtime/src/context/active-turn-context.js';
import type { ActiveTurnJournalPort, ActiveTurnJournalRecord } from '../../../packages/runtime/src/context/active-turn-journal.js';
import { ActiveTurnRecoveryCapture } from '../../../packages/runtime/src/context/recovery-assets.js';

const scope = { organId: id('organ', 'capture-organ'), taskId: id('task', 'capture-task'), cycleId: id('cycle', 'capture-cycle') };
const binding: ActiveTurnBinding = {
  execution: { runtimeId: 'capture-runtime', executionEpoch: 1 }, scope,
  admittedTurn: {
    turnId: 'business-turn', workAssignmentRef: 'assignment', taskRef: scope.taskId,
    scopeRef: scope, cycleRef: scope.cycleId, inputRevision: 1, directiveRevision: 1,
    executionEpoch: 1, runtimeBindingRef: 'capture-runtime', permissionRevision: 'grant-1',
    admissionEvidenceRefs: [], currentTurnRef: 'current', recoveryStateRef: 'recovery',
  },
  assignment: {
    assignmentId: 'assignment', taskId: scope.taskId, pipelineNodeId: 'node', attempt: 1,
    executionEpoch: 1, inputRevision: 1, objective: 'capture current turn', targetRefs: [],
    expectedOutputRefs: [], acceptanceCriteriaDigest: 'sha256:criteria', successCriteria: ['saved'],
    failureCriteria: ['lost'], incompleteCriteria: ['pending'], requiredCapabilities: [], mergeGate: 'not-required',
  },
};
const initialInput: RawAsset = {
  ref: { evidenceId: id('evidence', 'initial'), kind: 'execution', source: 'capture-fixture', locator: 'initial', digest: `sha256:${'a'.repeat(64)}`, scope },
  view: { kind: 'utf8-text' },
};
const captureInput = { pauseId: 'boundary', frozenAt: '2026-10-13T00:00:00.000Z', initialInput, checkpointPath: [], completionRefs: [] };
const request = { turnId: 'provider-turn', requestId: 'request-a' };
function envelope(seq: number): RawFactEnvelope {
  return { execution: binding.execution, scope, request, producerSeq: seq, fact: { kind: 'request-complete', terminal: 'completed' } };
}
async function open(beforeAppend?: (record: ActiveTurnJournalRecord) => Promise<void>) {
  const records: ActiveTurnJournalRecord[] = [];
  const commits = new Map<string, string>();
  const journal: ActiveTurnJournalPort = {
    async append(input) {
      await beforeAppend?.(input.record);
      const bytes = JSON.stringify(input.record);
      const previous = commits.get(input.commitId);
      if (previous !== undefined) {
        if (previous !== bytes) throw new Error('conflicting durable identity');
        return;
      }
      await Promise.resolve();
      commits.set(input.commitId, bytes);
      records.push(structuredClone(input.record));
    },
    async replay() { return structuredClone(records); },
  };
  const context = await ActiveTurnContext.open({ journal, binding, currentTurnRef: 'current' });
  return { context, records, journal };
}

test('request phases commit independently and concurrent producers receive unique acceptance order', async () => {
  let release!: () => void;
  const pendingWrite = new Promise<void>((resolve) => { release = resolve; });
  const { context, records } = await open(async (record) => {
    if (record.kind === 'accepted-fact') await pendingWrite;
  });
  await context.registerRequest({ request, scope, phase: 'dispatching' });
  await context.registerRequest({ request, scope, phase: 'dispatched' });
  assert.equal(records.filter((record) => record.kind === 'request').length, 2);
  await context.registerRequest({ request, scope, phase: 'dispatched' });
  assert.equal(records.filter((record) => record.kind === 'request').length, 2);
  const accepted = Promise.all([context.acceptRawFact(envelope(1)), context.acceptRawFact(envelope(2))]);
  const drain = context.closeAndDrainProducers();
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  assert.throws(() => context.capture(captureInput));
  release();
  const results = await accepted;
  await drain;
  assert.deepEqual(results.map((entry) => entry.seq), [1, 2]);
  const body = await context.prepareCapture(captureInput);
  assert.equal(body.cut.lastSeq, 2);
  assert.equal(context.controlRecordCount(), 5);
});

test('unregistered raw and unknown continuation fail without inventing registration', async () => {
  const { context, records } = await open();
  await assert.rejects(context.acceptRawFact(envelope(1)));
  assert.equal(records.length, 1);
  await assert.rejects(context.registerRequest({
    scope, phase: 'dispatching', parentRequestId: 'absent',
    request: { turnId: 'provider-turn', requestId: 'request-b', parentRequestId: 'absent' },
  }));
  assert.equal(records.length, 1);
  await assert.rejects(context.prepareCapture(captureInput));
});

test('capture closes admission and freezes a detached cut after the last durable producer acknowledgement', async () => {
  const { context } = await open();
  await context.registerRequest({ request, scope, phase: 'dispatching' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const producer = context.runProducer(async () => {
    await gate;
    await context.acceptRawFact(envelope(1));
    await context.registerRequest({ request, scope, phase: 'settled' });
  });
  assert.throws(() => context.capture(captureInput));
  let saved = false;
  const pending = context.prepareCapture(captureInput).then((body) => { saved = true; return body; });
  await assert.rejects(context.runProducer(() => { throw new Error('late producer ran'); }));
  assert.equal(saved, false);
  release();
  await producer;
  const body = await pending;
  assert.equal(body.entries.length, 1);
  assert.equal(body.requests.at(-1)?.phase, 'settled');
  const again = await context.prepareCapture({ ...captureInput, frozenAt: '2026-10-14T00:00:00.000Z' });
  assert.equal(again.cut.frozenAt, captureInput.frozenAt);
  assert.notEqual(again.binding, body.binding);
  (body.entries as unknown[]).length = 0;
  assert.equal(context.capture(captureInput).entries.length, 1);
  await assert.rejects(context.acceptRawFact(envelope(2)));
  await assert.rejects(context.prepareCapture({ ...captureInput, pauseId: 'different' }));
});

test('production capture calls bound drain and reads recovery references only after late acceptance', async () => {
  const { context } = await open();
  await context.registerInitialInput(initialInput);
  await context.registerProviderRequest({ execution: binding.execution, record: { request, scope, phase: 'dispatching' } });
  let release!: () => void;
  const lateWrite = new Promise<void>((resolve) => { release = resolve; });
  let referenced = false;
  let drained = false;
  const owner = new ActiveTurnRecoveryCapture(context, async () => {
    referenced = true;
    assert.equal(drained, true);
    return {
      checkpointPath: [], completionRefs: [], completionLookups: [],
      recovery: { commitIdentity: 'capture-boundary', rawTurnRefs: [], laterErrorRefs: [], unresolvedOperationRefs: [], stages: [], durablePhases: [], durableReceiptRefs: [], recoveryResponsibilityRef: 'recovery' },
    };
  }, () => new Date(captureInput.frozenAt));
  owner.bindProvider({
    async closeProductionAndDrain(input) {
      await lateWrite;
      await context.acceptRawFact(envelope(1));
      drained = true;
      return { ...input, requests: [{ request, lastProducerSeq: 1 }] };
    },
  });
  const prepared = owner.prepare('boundary');
  await Promise.resolve();
  assert.equal(referenced, false);
  assert.throws(() => context.assertProductionOpen());
  release();
  const result = await prepared;
  assert.equal(result.body.entries.length, 1);
  assert.equal(result.producerDrains.length, 1);
  assert.equal(result.controlRecordCount, 4);
  assert.deepEqual(result.body.initialInput, initialInput);
  assert.deepEqual(await owner.prepare('boundary'), result);
});
