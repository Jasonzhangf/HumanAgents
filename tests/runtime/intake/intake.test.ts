import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type RequirementEnvelope, type TaskId } from '../../../packages/contracts/src/index.js';
import { ExplicitIntake, type ExplicitInput } from '../../../packages/runtime/src/intake/explicit-intake.js';
import { RequirementInbox } from '../../../packages/runtime/src/intake/requirement-inbox.js';
import { ExplicitIntakeError, RequirementInboxError } from '../../../packages/runtime/src/intake/errors.js';

const currentTask = id('task', 'task-current');
const relatedTask = id('task', 'task-related');

function input(channel: ExplicitInput['channel'] = 'business'): ExplicitInput {
  return {
    sourceRef: 'ui:task-detail',
    rawInput: 'summarize the current task evidence',
    channel,
  };
}

async function createConfirmedEnvelope(
  intake: ExplicitIntake,
  requirementId: string,
  draftTask: TaskId = currentTask,
): Promise<RequirementEnvelope> {
  const interactionId = await intake.receive(input());
  await intake.beginMatching(interactionId);
  await intake.recordMatch(interactionId, {
    normalizedInput: `normalized ${requirementId}`,
    matchedTasks: [{ taskId: draftTask, relation: 'current', status: 'running' }],
    knownFacts: ['fixture'],
  });
  await intake.propose(interactionId, {
    proposedIntent: 'append',
    proposal: `append ${requirementId}`,
  });
  const snapshot = await intake.inspect(interactionId);
  assert.ok(snapshot.draft);
  return intake.confirm({
    draftId: snapshot.draft.draftId,
    requirementId,
    inputRevision: 1,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-11T00:00:00.000Z',
    payloadRef: `asset://requirements/${requirementId}`,
  });
}

test('explicit input advances through confirmation and dispatch exactly once', async () => {
  const inbox = new RequirementInbox();
  const intake = new ExplicitIntake(inbox);
  const interactionId = await intake.receive(input());

  let snapshot = await intake.inspect(interactionId);
  assert.equal(snapshot.state, 'received');
  assert.equal(snapshot.owner, 'explicit-intake');
  assert.equal(snapshot.nextAction, 'start-matching');
  assert.equal(snapshot.condition, 'matching-requested');

  await intake.beginMatching(interactionId);
  await intake.recordMatch(interactionId, {
    normalizedInput: '  summarize   current evidence  ',
    matchedTasks: [
      { taskId: currentTask, relation: 'current', status: 'running' },
      { taskId: relatedTask, relation: 'related', status: 'waiting' },
    ],
    knownFacts: ['task has evidence'],
  });
  await intake.propose(interactionId, {
    proposedIntent: 'append',
    proposal: 'append the normalized evidence request',
    decisionRefs: ['decision:task-match'],
  });

  snapshot = await intake.inspect(interactionId);
  assert.equal(snapshot.state, 'awaiting-confirmation');
  assert.equal(snapshot.owner, 'human');
  assert.equal(snapshot.nextAction, 'confirm-or-revise');
  assert.ok(snapshot.draft);

  await assert.rejects(() => intake.confirm({
    draftId: snapshot.draft!.draftId,
    requirementId: 'requirement-without-confirmation',
    inputRevision: 1,
    confirmedBy: '',
    confirmedAt: '2026-09-11T00:00:00.000Z',
    payloadRef: 'asset://requirements/unconfirmed',
  }), (error: unknown) => error instanceof ExplicitIntakeError && error.code === 'explicit-confirmation-required');
  assert.equal(inbox.size, 0);

  const envelope = await intake.confirm({
    draftId: snapshot.draft.draftId,
    requirementId: 'requirement-1',
    inputRevision: 1,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-11T00:00:00.000Z',
    payloadRef: 'asset://requirements/requirement-1',
  });
  assert.equal(envelope.fifoSeq, 1);
  assert.equal(envelope.taskRef?.value, currentTask.value);
  assert.deepEqual((await intake.inspect(interactionId)).history, [
    'received',
    'matching',
    'awaiting-intent',
    'awaiting-confirmation',
    'confirmed',
    'dispatched',
  ]);
  assert.equal((await intake.inspect(interactionId)).state, 'dispatched');
  assert.equal((await intake.inspect(interactionId)).owner, 'runtime-coordinator');
  assert.equal(inbox.size, 1);
  assert.deepEqual(await inbox.readNext({ consumerId: 'coordinator-1' }), envelope);
});

test('status queries and control commands never enter the business inbox', async () => {
  const inbox = new RequirementInbox();
  const intake = new ExplicitIntake(inbox);
  const interactionId = await intake.receive(input());
  await intake.beginMatching(interactionId);
  await intake.beginStatusCheck(interactionId);
  const receipt = await intake.completeStatusOnly(interactionId);

  assert.deepEqual(receipt, {
    kind: 'status-only',
    interactionId,
    owner: 'explicit-intake',
    nextAction: 'present-status',
  });
  assert.equal((await intake.inspect(interactionId)).state, 'status-only');
  assert.equal(inbox.size, 0);

  for (const controlCommand of ['steer', 'stop', 'revoke-permission'] as const) {
    await assert.rejects(() => intake.receive({
      ...input('control'),
      controlCommand,
    }), (error: unknown) => error instanceof ExplicitIntakeError && error.code === 'control-channel-required');
  }
  assert.equal(inbox.size, 0);
});

test('invalid transitions and rejection preserve explicit ownership', async () => {
  const intake = new ExplicitIntake(new RequirementInbox());
  const interactionId = await intake.receive(input());
  await assert.rejects(() => intake.confirm({
    draftId: 'missing',
    requirementId: 'requirement-before-draft',
    inputRevision: 1,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-11T00:00:00.000Z',
    payloadRef: 'asset://requirements/before-draft',
  }), (error: unknown) => error instanceof ExplicitIntakeError && error.code === 'draft-not-found');

  await intake.reject(interactionId, 'user cancelled before matching');
  const snapshot = await intake.inspect(interactionId);
  assert.equal(snapshot.state, 'rejected');
  assert.equal(snapshot.owner, 'explicit-intake');
  assert.equal(snapshot.nextAction, 'close-interaction');
  assert.equal(snapshot.condition, 'rejection-recorded');
  assert.equal(snapshot.reason, 'user cancelled before matching');
});

test('requirement inbox preserves FIFO and rejects duplicate, out-of-order, and unconfirmed envelopes', async () => {
  const inbox = new RequirementInbox();
  const intake = new ExplicitIntake(inbox);
  const first = await createConfirmedEnvelope(intake, 'requirement-1');
  const second = await createConfirmedEnvelope(intake, 'requirement-2');

  await assert.rejects(() => inbox.append(first), (error: unknown) => error instanceof RequirementInboxError && error.code === 'duplicate-envelope');
  const outOfOrder = { ...second, requirementId: 'requirement-3', draftId: 'draft-3', fifoSeq: 4 };
  inbox.markConfirmed(outOfOrder);
  await assert.rejects(() => inbox.append(outOfOrder), (error: unknown) => error instanceof RequirementInboxError && error.code === 'out-of-order-envelope');
  await assert.rejects(() => inbox.append({
    ...second,
    requirementId: 'requirement-unconfirmed',
    draftId: 'draft-unconfirmed',
    fifoSeq: 3,
  }), (error: unknown) => error instanceof RequirementInboxError && error.code === 'unconfirmed-envelope');

  assert.deepEqual(await inbox.readNext({ consumerId: 'coordinator-1' }), first);
  assert.deepEqual(await inbox.readNext({ consumerId: 'coordinator-1' }), second);
  assert.equal(await inbox.readNext({ consumerId: 'coordinator-1' }), null);
  assert.equal(inbox.size, 0);
});
