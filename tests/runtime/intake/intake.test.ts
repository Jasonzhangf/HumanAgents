import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type RequirementEnvelope, type TaskId } from '../../../packages/contracts/src/index.js';
import { ExplicitIntake, type ExplicitInput } from '../../../packages/runtime/src/intake/explicit-intake.js';
import { RequirementInbox } from '../../../packages/runtime/src/intake/requirement-inbox.js';
import { ExplicitIntakeError, RequirementInboxError } from '../../../packages/runtime/src/intake/errors.js';
import {
  ConfirmationLedger,
  RequirementSubmissionOwner,
} from '../../../packages/runtime/src/explicit-brain/router.js';

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
  inbox: RequirementInbox,
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
  const confirmed = await intake.prepareConfirmation({
    draftId: snapshot.draft.draftId,
    inputRevision: 1,
    confirmationRef: `confirm:${requirementId}`,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-11T00:00:00.000Z',
    payloadRef: `asset://requirements/${requirementId}`,
  });
  const ledger = new ConfirmationLedger();
  ledger.registerDraft({
    interactionId: confirmed.interactionId,
    draftId: confirmed.draftId,
    inputRevision: confirmed.inputRevision,
    normalizedInput: confirmed.normalizedInput,
    intent: confirmed.intent,
    taskRef: confirmed.taskRef,
    payloadRef: confirmed.payloadRef,
  });
  ledger.confirm({
    interactionId: confirmed.interactionId,
    draftId: confirmed.draftId,
    inputRevision: confirmed.inputRevision,
    confirmationRef: confirmed.confirmationRef,
    confirmedBy: confirmed.confirmedBy,
    confirmedAt: confirmed.confirmedAt,
  });
  const receipt = await new RequirementSubmissionOwner(ledger, inbox, {
    async submit(envelope) { return { requirementId: envelope.requirementId }; },
  }).submit({
    interactionId: confirmed.interactionId,
    draftId: confirmed.draftId,
    confirmationRef: confirmed.confirmationRef,
    inputRevision: confirmed.inputRevision,
  });
  const envelope = inbox.find(receipt.draftId);
  assert.ok(envelope);
  return envelope;
}

test('explicit input advances through confirmation and dispatch exactly once', async () => {
  const inbox = new RequirementInbox();
  const intake = new ExplicitIntake();
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

  await assert.rejects(() => intake.prepareConfirmation({
    draftId: snapshot.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:without-human',
    confirmedBy: '',
    confirmedAt: '2026-09-11T00:00:00.000Z',
    payloadRef: 'asset://requirements/unconfirmed',
  }), (error: unknown) => error instanceof ExplicitIntakeError && error.code === 'explicit-confirmation-required');
  assert.equal(inbox.size, 0);

  const confirmed = await intake.prepareConfirmation({
    draftId: snapshot.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:requirement-1',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-11T00:00:00.000Z',
    payloadRef: 'asset://requirements/requirement-1',
  });
  const ledger = new ConfirmationLedger();
  ledger.registerDraft({
    interactionId: confirmed.interactionId,
    draftId: confirmed.draftId,
    inputRevision: confirmed.inputRevision,
    normalizedInput: confirmed.normalizedInput,
    intent: confirmed.intent,
    taskRef: confirmed.taskRef,
    payloadRef: confirmed.payloadRef,
  });
  ledger.confirm({
    interactionId: confirmed.interactionId,
    draftId: confirmed.draftId,
    inputRevision: confirmed.inputRevision,
    confirmationRef: confirmed.confirmationRef,
    confirmedBy: confirmed.confirmedBy,
    confirmedAt: confirmed.confirmedAt,
  });
  const receipt = await new RequirementSubmissionOwner(ledger, inbox, {
    async submit(envelope) { return { requirementId: envelope.requirementId }; },
  }).submit({
    interactionId: confirmed.interactionId,
    draftId: confirmed.draftId,
    confirmationRef: confirmed.confirmationRef,
    inputRevision: confirmed.inputRevision,
  });
  const envelope = inbox.find(receipt.draftId);
  assert.ok(envelope);
  assert.equal(envelope.fifoSeq, 1);
  assert.equal(envelope.intent, 'append');
  assert.equal(envelope.normalizedInput, '  summarize   current evidence  ');
  assert.equal(envelope.taskRef?.value, currentTask.value);
  assert.equal(envelope.payloadRef, 'asset://requirements/requirement-1');
  await intake.markDraftDispatched(envelope.draftId);
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
  const intake = new ExplicitIntake();
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
  const intake = new ExplicitIntake();
  const interactionId = await intake.receive(input());
  await assert.rejects(() => intake.prepareConfirmation({
    draftId: 'missing',
    inputRevision: 1,
    confirmationRef: 'confirmation:before-draft',
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

test('requirement inbox preserves FIFO and idempotently recovers the same confirmed envelope', async () => {
  const inbox = new RequirementInbox();
  const intake = new ExplicitIntake();
  const first = await createConfirmedEnvelope(intake, inbox, 'requirement-1');
  const second = await createConfirmedEnvelope(intake, inbox, 'requirement-2');

  assert.deepEqual(await inbox.append(first), {
    requirementId: first.requirementId,
    draftId: first.draftId,
    fifoSeq: first.fifoSeq,
  });
  assert.deepEqual(inbox.find(first.draftId), first);
  const conflictingEnvelope: RequirementEnvelope = {
    ...first,
    requirementId: 'requirement-conflict',
  };
  inbox.markConfirmed(conflictingEnvelope);
  await assert.rejects(
    () => inbox.append(conflictingEnvelope),
    (error: unknown) => error instanceof RequirementInboxError && error.code === 'duplicate-envelope',
  );
  const outOfOrder: RequirementEnvelope = {
    requirementId: 'requirement-3',
    draftId: 'draft-3',
    inputRevision: 1,
    intent: 'create',
    normalizedInput: 'out of order',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-11T00:00:00.000Z',
    fifoSeq: 4,
    payloadRef: 'asset://requirements/out-of-order',
  };
  inbox.markConfirmed(outOfOrder);
  await assert.rejects(() => inbox.append(outOfOrder), (error: unknown) => error instanceof RequirementInboxError && error.code === 'out-of-order-envelope');
  await assert.rejects(() => inbox.append({
    requirementId: 'requirement-unconfirmed',
    draftId: 'draft-unconfirmed',
    inputRevision: 1,
    intent: 'create',
    normalizedInput: 'unconfirmed',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-11T00:00:00.000Z',
    fifoSeq: 3,
    payloadRef: 'asset://requirements/unconfirmed',
  }), (error: unknown) => error instanceof RequirementInboxError && error.code === 'unconfirmed-envelope');

  assert.deepEqual(await inbox.peekNext({ consumerId: 'coordinator-1' }), first);
  await assert.rejects(
    () => inbox.acknowledge({ consumerId: 'coordinator-1', requirementId: second.requirementId }),
    (error: unknown) => error instanceof RequirementInboxError && error.code === 'out-of-order-envelope',
  );
  assert.equal(inbox.size, 2);
  assert.deepEqual(
    await inbox.acknowledge({ consumerId: 'coordinator-1', requirementId: first.requirementId }),
    { requirementId: first.requirementId, draftId: first.draftId, fifoSeq: first.fifoSeq },
  );
  assert.deepEqual(await inbox.readNext({ consumerId: 'coordinator-1' }), second);
  assert.equal(await inbox.readNext({ consumerId: 'coordinator-1' }), null);
  assert.equal(inbox.size, 0);
});
