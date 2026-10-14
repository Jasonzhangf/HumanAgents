import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type ActiveTurnBinding,
  type AcceptedChildDelivery,
  type RawAsset,
  type RawFactEnvelope,
  type ReviewAssignment,
  type ReviewResult,
  type WorkResult,
} from '../../../packages/contracts/src/index.js';
import { ActiveTurnContext } from '../../../packages/runtime/src/context/active-turn-context.js';
import type { ActiveTurnJournalPort, ActiveTurnJournalRecord } from '../../../packages/runtime/src/context/active-turn-journal.js';
import { ActiveTurnRecoveryCapture } from '../../../packages/runtime/src/context/recovery-assets.js';

const scope = { organId: id('organ', 'capture-organ'), taskId: id('task', 'capture-task'), cycleId: id('cycle', 'capture-cycle') };

async function expectRejects(fn: () => Promise<unknown>, substring: string): Promise<void> {
  let caught: unknown;
  try { await fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error, `expected a rejection containing "${substring}"`);
  assert.ok((caught as Error).message.includes(substring), `expected "${(caught as Error).message}" to contain "${substring}"`);
}

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

const childResult: WorkResult = {
  taskId: scope.taskId, pipelineNodeId: binding.assignment.pipelineNodeId, agentId: 'child-agent',
  assignmentId: binding.assignment.assignmentId, attempt: binding.assignment.attempt,
  executionEpoch: binding.assignment.executionEpoch, inputRevision: binding.assignment.inputRevision,
  producedArtifactRefs: [], producedArtifactDigests: [], status: 'succeeded',
  summary: 'child delivery', outputRefs: [],
  evidenceRefs: [{
    evidenceId: id('evidence', 'child-result'), kind: 'execution', source: 'runtime-fixture',
    locator: 'child-result', digest: `sha256:${'b'.repeat(64)}`, scope,
  }],
  nextAction: 'settle',
};
const childDeliveryAsset: RawAsset = {
  ref: {
    evidenceId: id('evidence', 'child-refined'), kind: 'execution', source: 'runtime-fixture',
    locator: 'child-refined', digest: `sha256:${'c'.repeat(64)}`, scope,
  },
  view: { kind: 'utf8-text' },
};
const reviewAssignment: ReviewAssignment = {
  assignmentId: 'review-assignment', taskId: scope.taskId.value, workerAgentId: 'review-agent',
  reviewKind: 'quality', attempt: 1, executionEpoch: binding.execution.executionEpoch, inputRevision: 1,
  acceptanceCriteriaDigest: binding.assignment.acceptanceCriteriaDigest, subjectRefs: ['subject:a'],
  subjectDigests: [`sha256:${'d'.repeat(64)}`], workerCapabilities: ['provider.execution'],
  requiredCapabilities: ['review.quality'], mergeGate: 'not-required',
};
const reviewResult: ReviewResult = {
  resultId: 'review-result', assignmentId: reviewAssignment.assignmentId, taskId: reviewAssignment.taskId,
  workerAgentId: reviewAssignment.workerAgentId, reviewKind: reviewAssignment.reviewKind,
  attempt: reviewAssignment.attempt, executionEpoch: reviewAssignment.executionEpoch,
  inputRevision: reviewAssignment.inputRevision, acceptanceCriteriaDigest: reviewAssignment.acceptanceCriteriaDigest,
  subjectRefs: reviewAssignment.subjectRefs, subjectDigests: reviewAssignment.subjectDigests,
  status: 'passed', findings: [],
  evidenceRefs: [{
    evidenceId: id('evidence', 'review-result'), kind: 'execution', source: 'runtime-fixture',
    locator: 'review-result', digest: `sha256:${'e'.repeat(64)}`, scope,
  }],
};
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

test('a missing return is not a decision: it rejects and keeps the child duty', async () => {
  const { context } = await open();
  await context.openChildInvocation({
    invocationId: 'child-missing', childTurnId: 'child-turn-missing', checkpointReceiptRef: 'pre-call-m',
    binding: { kind: 'execution', assignment: binding.assignment },
  });
  // The invocation owes work while its return is unknown.
  const prefix = await context.readLivePrefix('runtime-fixture');
  assert.deepEqual(prefix.obligations, [{ kind: 'child-invocation', invocationId: 'child-missing', phase: 'pending' }]);
  // Declining before a durable return rejects and leaves the invocation unresolved.
  await expectRejects(() => context.recordChildNonSelection('child-missing'), 'not been durably returned');
  assert.equal(context.childInvocations()[0]!.notSelectedResultSeq, undefined);
  assert.equal(context.entries().length, 0);
});

test('a known non-selection discharges the child duty without losing the retained delivery', async () => {
  const { context } = await open();
  await context.openChildInvocation({
    invocationId: 'child-a', childTurnId: 'child-turn-a', checkpointReceiptRef: 'pre-call-a',
    binding: { kind: 'execution', assignment: binding.assignment },
  });
  const delivery = await context.recordChildReturn({
    kind: 'execution', invocationId: 'child-a', assignment: binding.assignment, result: childResult,
    refinedDelivery: childDeliveryAsset,
  });
  // The return is known but the parent decision is still pending: the duty remains.
  let prefix = await context.readLivePrefix('runtime-fixture');
  assert.deepEqual(prefix.obligations, [{ kind: 'child-invocation', invocationId: 'child-a', phase: 'pending' }]);

  await context.recordChildNonSelection('child-a');
  const decision = context.childInvocations()[0]!;
  assert.equal(decision.notSelectedResultSeq, delivery.seq);
  assert.equal(decision.adoptedResultSeq, undefined);
  // The durable non-selection discharges the child decision duty.
  prefix = await context.readLivePrefix('runtime-fixture');
  assert.deepEqual(prefix.obligations, []);
  // The declined delivery stays immutable evidence.
  assert.deepEqual(context.entries().find((entry) => !('envelope' in entry)), delivery);
  // A repeat of the same decision is idempotent: no new record.
  const before = context.controlRecordCount();
  await context.recordChildNonSelection('child-a');
  assert.equal(context.controlRecordCount(), before);
});

test('adoption and non-selection are mutually exclusive terminal decisions', async () => {
  const { context } = await open();
  await context.openChildInvocation({
    invocationId: 'child-b', childTurnId: 'child-turn-b', checkpointReceiptRef: 'pre-call-b',
    binding: { kind: 'execution', assignment: binding.assignment },
  });
  const declined: AcceptedChildDelivery = await context.recordChildReturn({
    kind: 'execution', invocationId: 'child-b', assignment: binding.assignment, result: childResult,
    refinedDelivery: childDeliveryAsset,
  });
  await context.recordChildNonSelection('child-b');
  await expectRejects(() => context.recordChildAdoption('child-b', declined), 'was already declined');
  assert.equal(context.childInvocations()[0]!.adoptedResultSeq, undefined);
  assert.equal(context.childInvocations()[0]!.notSelectedResultSeq, declined.seq);

  await context.openChildInvocation({
    invocationId: 'child-c', childTurnId: 'child-turn-c', checkpointReceiptRef: 'pre-call-c',
    binding: { kind: 'execution', assignment: binding.assignment },
  });
  const adopted = await context.recordChildReturn({
    kind: 'execution', invocationId: 'child-c', assignment: binding.assignment, result: childResult,
    refinedDelivery: childDeliveryAsset,
  });
  await context.recordChildAdoption('child-c', adopted);
  await expectRejects(() => context.recordChildNonSelection('child-c'), 'already adopted');
  assert.equal(context.childInvocations().find((record) => record.invocationId === 'child-c')!.notSelectedResultSeq, undefined);
});

test('a review post-checkpoint requires the durable review return, not adoption', async () => {
  const { context } = await open();
  await context.openChildInvocation({
    invocationId: 'review-a', childTurnId: 'review-turn-a', checkpointReceiptRef: 'pre-call-r',
    binding: { kind: 'review', assignment: reviewAssignment },
  });
  // No durable review return yet: the checkpoint must still be refused.
  await expectRejects(() => context.recordReviewCheckpoint('review-a', 'post-review-r'), 'before its durable return');

  await context.recordChildReturn({
    kind: 'review', invocationId: 'review-a', assignment: reviewAssignment, result: reviewResult,
    refinedDelivery: childDeliveryAsset,
  });
  // The return is known and no adoption has been manufactured, yet the checkpoint commits.
  await context.recordReviewCheckpoint('review-a', 'post-review-r');
  const record = context.childInvocations()[0]!;
  assert.equal(record.postReviewCheckpointRef, 'post-review-r');
  assert.equal(record.adoptedResultSeq, undefined);
  assert.equal(record.notSelectedResultSeq, undefined);

  // Distinct pre-call and single post-review checkpoint guards still hold.
  await expectRejects(() => context.recordReviewCheckpoint('review-a', 'pre-call-r'), 'must differ');
  await expectRejects(() => context.recordReviewCheckpoint('review-a', 'another'), 'already has a review-result checkpoint');
  assert.equal(context.childInvocations()[0]!.postReviewCheckpointRef, 'post-review-r');
});
